/*
 * Copyright (c) 2014 Adobe Systems Incorporated. All rights reserved.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a
 * copy of this software and associated documentation files (the "Software"),
 * to deal in the Software without restriction, including without limitation
 * the rights to use, copy, modify, merge, publish, distribute, sublicense,
 * and/or sell copies of the Software, and to permit persons to whom the
 * Software is furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
 * FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
 * DEALINGS IN THE SOFTWARE.
 *
 */

(function () {
    "use strict";

    var util = require("util"),
        EventEmitter = require("events").EventEmitter;

    var Q = require("q");

    var Document = require("./dom/document");

    /**
     * The DocumentManager provides a simple interface for requesting and maintaining
     * up-to-date Document objects from Photoshop.
     * 
     * @constructor
     * @param {Generator} generator
     * @param {object} config
     * @param {Logger} logger
     */
    function DocumentManager(generator, config, logger) {
        EventEmitter.call(this);
        
        this._generator = generator;
        this._config = config;
        this._logger = logger;

        this._documents = {};
        this._documentDeferreds = {};
        this._documentChanges = {};

        generator.onPhotoshopEvent("imageChanged", this._handleImageChanged.bind(this));
    }

    util.inherits(DocumentManager, EventEmitter);

    /**
     * The Generator instance.
     * 
     * @private
     * @type {Generator}
     */
    DocumentManager.prototype._generator = null;

    /**
     * A set of per-document-ID up-to-date Document objects.
     *
     * @private
     * @type {Object.<number: Document>}
     */
    DocumentManager.prototype._documents = null;

    /**
     * A set of per-document-ID deferred objects that indicate Document creation in progress.
     * 
     * @private
     * @type {Object.<number: Deferred>}
     */
    DocumentManager.prototype._documentDeferreds = null;

    /**
     * A set of per-document-ID change queues.
     * 
     * @private
     * @type {Object.<number: Array.<object>>}
     */
    DocumentManager.prototype._documentChanges = null;

    /**
     * Asynchronously create a new Document object using the full document
     * description from Photoshop. 
     * 
     * @private
     * @param {!number} id The ID of the Document to create
     * @return {Promise.<Document>} A promis that resolves with a new Document object for the given ID.
     */
    DocumentManager.prototype._getEntireDocument = function (id) {
        return this._generator.getDocumentInfo(id).then(function (raw) {
            // this._logger.debug(JSON.stringify(raw, null, "  "));
            return new Document(this._generator, this._config, this._logger, raw);
        }.bind(this));
    };

    /**
     * Asynchronously re-initialize the Document object for a given document ID,
     * discarding the previous Document object and clearing the change queue for
     * that ID.
     * 
     * @private
     * @param {!number} id The ID of the Document to re-initialize
     */
    DocumentManager.prototype._resetDocument = function (id) {
        this._documentChanges[id] = [];
        delete this._documents[id];

        this._getEntireDocument(id).done(function (document) {
            // Dispose of this document reference when the document is closed in Photoshop
            document.on("closed", function () {
                delete this._documents[id];
                delete this._documentChanges[id];

                if (this._documentDeferreds.hasOwnProperty(id)) {
                    this._documentDeferreds[id].reject();
                    delete this._documentDeferreds[id];
                }
            }.bind(this));

            this._documents[id] = document;
            this._processNextChange(id);
        }.bind(this), function (err) {
            this._logger.error("Failed to get document:", err);
            this._documentDeferreds[id].reject(err);
        }.bind(this));
    };

    /**
     * Asynchronously initialize a Document object for the given document ID.
     *  
     * @private
     * @param {!number} id The ID of the Document to initialize
     * @return {Promise.<Document>} A promise that resolves with the up-to-date Document
     */
    DocumentManager.prototype._initDocument = function (id) {
        var deferred = Q.defer();

        this._documentDeferreds[id] = deferred;
        this._resetDocument(id);

        return deferred;
    };

    /**
     * For the given document change queue, attempt to apply the next
     * change from the queue to the appropriate Document. If unable to
     * apply the change, re-request the entire document. Otherwise, 
     * continue processing changes from the change queue.
     * 
     * @private
     * @param {!number} id The document ID that indicates the change queue to process
     */
    DocumentManager.prototype._processNextChange = function (id) {
        var document = this._documents[id],
            changes = this._documentChanges[id],
            deferred = this._documentDeferreds[id];

        if (!changes || !deferred) {
            // The document was closed while processing changes
            return;
        }

        if (changes.length === 0) {
            deferred.resolve(document);
            delete this._documentDeferreds[id];
            return;
        }

        var change = changes.shift();
        this._logger.debug("Applying change: ", JSON.stringify(change, null, "  "));

        var success = document._applyChange(change);
        if (!success) {
            this._logger.warn("Unable to apply change to document");
            this._resetDocument(id);
        } else {
            this._processNextChange(id);
        }
    };

    /**
     * Handler for Photoshop's imageChanged event. Accepts a raw change description object
     * and, if the change is intended for an extant Document object, updates that object
     * accordingly. Ignores changes for document IDs for which getDocument has not been
     * called.
     * 
     * @private
     * @param {object} change A raw change description object
     */
    DocumentManager.prototype._handleImageChanged = function (change) {
        var id = change.id;
        if (!id) {
            this._logger.warn("Received change for unknown document:", change);
            return;
        }

        // ignore changes for document IDs until a client calls getDocument
        if (!this._documentDeferreds.hasOwnProperty(id) && !this._documents.hasOwnProperty(id)) {
            return;
        }

        if (!this._documentChanges.hasOwnProperty(id)) {
            this._documentChanges[id] = [];
        }

        var changes = this._documentChanges[id],
            pendingChanges = changes.push(change);

        if (pendingChanges === 1 && !this._documentDeferreds.hasOwnProperty(id)) {
            if (this._documents.hasOwnProperty(id)) {
                this._documentDeferreds[id] = Q.defer();
                this._processNextChange(id);
            } else {
                this._initDocument(id);
            }
        }
    };

    /**
     * Asynchonously request an up-to-date Document object for the given document ID.
     *
     * @param {!number} id The document ID
     * @return {Promise.<Document>} A promise that resoves with a Document object for the given ID
     */
    DocumentManager.prototype.getDocument = function (id) {
        // We're in the process of updating the document; return that when it's ready
        if (this._documentDeferreds.hasOwnProperty(id)) {
            return this._documentDeferreds[id].promise;
        }

        // We have a document and we aren't updating it; return it immediately
        if (this._documents.hasOwnProperty(id)) {
            return new Q(this._documents[id]);
        }

        // We don't know anything about this document; fetch it from Photoshop
        var deferred = this._initDocument(id);

        return deferred.promise;
    };

    module.exports = DocumentManager;
}());