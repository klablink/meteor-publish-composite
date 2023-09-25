class PublishedDocument {
    constructor(collectionName, docId) {
        this.collectionName = collectionName
        this.docId = docId
        this.childPublications = []
        this._isFlaggedForRemoval = false
    }

    addChildPub(childPublication) {
        this.childPublications.push(childPublication)
    }

    async eachChildPub(callback) {
        for (const childPublication of this.childPublications) {
            await callback(childPublication)
        }
    }

    isFlaggedForRemoval() {
        return this._isFlaggedForRemoval
    }

    unflagForRemoval() {
        this._isFlaggedForRemoval = false
    }

    flagForRemoval() {
        this._isFlaggedForRemoval = true
    }
}

export default PublishedDocument
