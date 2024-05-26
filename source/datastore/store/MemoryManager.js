import { guid } from '../../core/Core.js';
import {
    invokeAfterDelay,
    invokeInNextEventLoop,
} from '../../foundation/RunLoop.js';
import { Query } from '../query/Query.js';
import { Record } from '../record/Record.js';

/**
    Class: O.MemoryManager

    A MemoryManager instance periodically checks the store to ensure it doesn't
    have beyond a certain number of records in memory. If it does, the least
    recently used records are removed until the limit has no longer been
    breached.
*/

class MemoryManager {
    /**
        Property (private): O.MemoryManager#_index
        Type: Number

        Keeps track of which record type we need to examine next.
    */

    /**
        Property (private): O.MemoryManager#_store
        Type: O.Store

        The store where the records are stored.
    */

    /**
        Property (private): O.MemoryManager#_restrictions
        Type: Array

        An array of objects, each containing the properties:
        - Type: The constructor for the Record or Query subclass.
        - max: The maximum number allowed.
        - afterCleanup: An optional callback after cleanup, which will be given
          an array of removed objects of the given type, every time some are
          removed from the store.
    */

    /**
        Property: O.MemoryManager#timeout
        Type: Number
        Default: 30000 (30 seconds)

        The time in milliseconds between running the cleanup function.
    */

    /**
        Constructor: O.MemoryManager

        Parameters:
            store        - {Store} The store to be memory managed.
            restrictions - {Array} An array of objects, each containing the
                           properties:
                           * Type: The constructor for the Record or Query
                             subclass.
                           * max: The maximum number allowed.
                           * afterCleanup: An optional callback after cleanup,
                             which will be given an array of removed objects of
                             the given type, every time some are removed from
                             the store.
            timeout      - {Number} (optional) How long after a change the
                           cleanup function is called in milliseconds. Default
                           is 30000.
    */
    constructor(store, restrictions, timeout) {
        this._index = 0;
        this._store = store;
        this._restrictions = restrictions;
        this._timer = null;
        this._isRunning = false;

        this.isPaused = false;
        this.timeout = timeout || 30000;

        restrictions.forEach(({ Type }) => {
            if (Type.prototype instanceof Record) {
                store.on(Type, this, 'needsCleanup');
            }
        });
    }

    /**
        Method: O.MemoryManager#addRestriction

        Parameters:
            restriction - {Object} An object describing the restriction for a
                          type (see constructor for format).

        Adds a restriction for a new type after initialisation.

        Returns:
            {O.MemoryManager} Returns self.
    */
    addRestriction(restriction) {
        this._restrictions.push(restriction);
        return this;
    }

    needsCleanup() {
        if (!this._timer && !this._isRunning) {
            this._timer = invokeAfterDelay(this.cleanup, this.timeout, this);
        }
    }

    /**
        Method: O.MemoryManager#cleanup

        Examines the store to see how many entries of each record type are
        present and removes references to the least recently accessed records
        until the number is under the set limit for that type. This is
        automatically called periodically by the memory manager.
    */
    cleanup() {
        this._timer = null;
        let index = this._index;
        const restrictions = this._restrictions[index];
        const Type = restrictions.Type;
        let ParentType = Type;
        const max = restrictions.max;
        const afterFn = restrictions.afterCleanup;
        let deleted;

        if (!this._isRunning && this.isPaused) {
            this.needsCleanup();
            return;
        }
        this._isRunning = true;

        do {
            if (ParentType === Record) {
                deleted = this.cleanupRecordType(Type, max);
                break;
            } else if (ParentType === Query) {
                deleted = this.cleanupQueryType(Type, max);
                break;
            }
        } while ((ParentType = ParentType.parent.constructor));

        if (afterFn) {
            afterFn(deleted);
        }

        this._index = index = (index + 1) % this._restrictions.length;

        // Yield between examining types so we don't hog the event queue.
        if (index) {
            invokeInNextEventLoop(this.cleanup, this);
        } else {
            this._isRunning = false;
        }
    }

    /**
        Method: O.MemoryManager#cleanupRecordType

        Parameters:
            Type - {O.Class} The record type.
            max  - {Number} The maximum number allowed.

        Removes excess records from the store.
    */
    cleanupRecordType(Type, max) {
        const store = this._store;
        const _skToLastAccess = store._skToLastAccess;
        const _skToData = store._skToData;
        const storeKeys = Object.keys(store._typeToSKToId[guid(Type)] || {});
        const length = storeKeys.length;
        let numberToDelete = length - max;
        const deleted = [];

        storeKeys.sort((a, b) => {
            return _skToLastAccess[b] - _skToLastAccess[a];
        });

        for (let i = length - 1; numberToDelete > 0 && i >= 0; i -= 1) {
            const storeKey = storeKeys[i];
            const data = _skToData[storeKey];
            if (store.unloadRecord(storeKey)) {
                numberToDelete -= 1;
                if (data) {
                    deleted.push(data);
                }
            }
        }
        return deleted;
    }

    /**
        Method: O.MemoryManager#cleanupQueryType

        Parameters:
            Type - {O.Class} The query type.
            max  - {Number} The maximum number allowed.

        Removes excess remote queries from the store.
    */
    cleanupQueryType(Type, max) {
        const queries = this._store.getAllQueries().filter((query) => {
            return query instanceof Type;
        });
        const length = queries.length;
        let numberToDelete = length - max;
        const deleted = [];

        queries.sort((a, b) => {
            return b.lastAccess - a.lastAccess;
        });
        for (let i = length - 1; numberToDelete > 0 && i >= 0; i -= 1) {
            const query = queries[i];
            if (!query.hasObservers() && !query.hasRangeObservers()) {
                query.destroy();
                deleted.push(query);
                numberToDelete -= 1;
            }
        }
        return deleted;
    }
}

export { MemoryManager };
