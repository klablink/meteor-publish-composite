import { check, Match } from 'meteor/check'

import { debugLog } from './logging'
import PublishedDocumentList from './published_document_list'

class Publication {
    constructor(subscription, options, args) {
        check(options, {
            find: Function,
            children: Match.Optional(Match.OneOf([Object], Function)),
            collectionName: Match.Optional(String),
        })

        this.subscription = subscription
        this.options = options
        this.args = args || []
        this.childrenOptions = options.children || []
        this.publishedDocs = new PublishedDocumentList()
        this.collectionName = options.collectionName
    }

    async publish() {
        this.cursor = this._getCursor()
        if (!this.cursor) {
            return
        }

        const collectionName = this._getCollectionName()

        const docAdded = async (doc) => {
            const alreadyPublished = this.publishedDocs.has(doc._id)

            if (alreadyPublished) {
                debugLog('Publication.observeHandle.added', `${collectionName}:${doc._id} already published`)
                this.publishedDocs.unflagForRemoval(doc._id)
                await this._republishChildrenOf(doc)
                this.subscription.changed(collectionName, doc._id, doc)
            } else {
                debugLog('Publication.observeHandle.added', `${collectionName}:${doc._id} already`)
                this.publishedDocs.add(collectionName, doc._id)
                await this._publishChildrenOf(doc)
                this.subscription.added(collectionName, doc)
            }
        }

        // Use Meteor.bindEnvironment to make sure the callbacks are run with the same
        // environmentVariables as when publishing the "parent".
        // It's only needed when publish is being recursively run.
        for(const doc of await this.cursor.fetchAsync()) {
            await docAdded(doc);
        }

        let initialized = false;
        this.observeHandle = await this.cursor.observe({
            added: async (doc) => {
                if(initialized) {
                    await docAdded(doc);
                }
            },
            changed: async (newDoc, oldDoc) => {
                debugLog('Publication.observeHandle.changed', `${collectionName}:${newDoc._id}`)
                await this._republishChildrenOf(newDoc)
                this.subscription.changed(collectionName, newDoc._id,
                    [...new Set([...Object.keys(newDoc), ...Object.keys(oldDoc)])]
                        .filter(key => newDoc[key] !== oldDoc[key])
                        .reduce((changes, key) => ({ ...changes, [key]: newDoc[key] }), {}))
            },
            removed: async (doc) => {
                debugLog('Publication.observeHandle.removed', `${collectionName}:${doc._id}`)
                await this._removeDoc(collectionName, doc._id)
            },
        })
        initialized = true;
    }

    unpublish() {
        debugLog('Publication.unpublish', this._getCollectionName())
        this._stopObservingCursor()
        this._unpublishAllDocuments()
    }

    async _republish() {
        this._stopObservingCursor()

        this.publishedDocs.flagAllForRemoval()

        debugLog('Publication._republish', 'run .publish again')
        await this.publish()

        debugLog('Publication._republish', 'unpublish docs from old cursor')
        this._removeFlaggedDocs()
    }

    _getCursor() {
        return this.options.find.apply(this.subscription.meteorSub, this.args)
    }

    _getCollectionName() {
        return this.collectionName || (this.cursor && this.cursor._getCollectionName())
    }

    async _publishChildrenOf(doc) {
        const children = typeof this.childrenOptions === 'function'
            ? this.childrenOptions(doc, ...this.args) : this.childrenOptions
        for (const options of children) {
            const pub = new Publication(this.subscription, options, [doc].concat(this.args))
            this.publishedDocs.addChildPub(doc._id, pub)
            await pub.publish()
        }
    }

    async _republishChildrenOf(doc) {
        const parentArgs = this.args
        let newArgs
        await this.publishedDocs.eachChildPub(doc._id, async (publication) => {
            // Check if parent's args are the same length as this publication
            // Intuitively this should not ever be the case!
            // However, it does happen sometimes.
            // When it does, the first argument of the parent publication is the doc.
            // So we skip this to avoid creating a duplicate of the first argument.
            if (parentArgs.length === publication.args.length) {
                newArgs = parentArgs.slice(1)
            } else {
                newArgs = parentArgs
            }

            // The First argument is the new document
            // Subsequent args are passed down from parent.
            // These may have been updated by a grandparent publication.
            publication.args = [doc, ...newArgs]

            await publication._republish()
        })
    }

    _unpublishAllDocuments() {
        this.publishedDocs.eachDocument((doc) => {
            this._removeDoc(doc.collectionName, doc.docId)
        }, this)
    }

    _stopObservingCursor() {
        debugLog('Publication._stopObservingCursor', 'stop observing cursor')

        if (this.observeHandle) {
            this.observeHandle.stop()
            delete this.observeHandle
        }
    }

    _removeFlaggedDocs() {
        this.publishedDocs.eachDocument((doc) => {
            if (doc.isFlaggedForRemoval()) {
                this._removeDoc(doc.collectionName, doc.docId)
            }
        }, this)
    }

    async _removeDoc(collectionName, docId) {
        this.subscription.removed(collectionName, docId)
        await this._unpublishChildrenOf(docId)
        this.publishedDocs.remove(docId)
    }

    async _unpublishChildrenOf(docId) {
        debugLog('Publication._unpublishChildrenOf', `unpublishing children of ${this._getCollectionName()}:${docId}`)

        await this.publishedDocs.eachChildPub(docId, (publication) => {
            publication.unpublish()
        })
    }
}

export default Publication
