import { Class, clone, meta } from '../../core/Core.js';
import { Obj } from '../../foundation/Object.js';
import { didError } from '../../foundation/RunLoop.js';
import { AttributeErrors } from './AttributeErrors.js';
import { RecordResult } from './RecordResult.js';
import {
    DIRTY,
    LOADING,
    NEW,
    NON_EXISTENT,
    OBSOLETE,
    READY,
} from './Status.js';
import { ToOneAttribute } from './toOne.js';

/* { property, nocache } from */
import '../../foundation/Decorators.js';

const READY_NEW_DIRTY = READY | NEW | DIRTY;

/**
    Class: O.Record

    Extends: O.Object

    All data object classes managed by the store must inherit from Record. This
    provides the basic status management for the attributes.
*/
const Record = Class({
    Name: 'Record',

    Extends: Obj,

    /**
        Constructor: O.Record

        Parameters:
            store    - {Store} The store to link to this record.
            storeKey - {String} (optional) The unique id for this record in the
                       store. If ommitted, a new record will be created, which
                       can then be committed to the store using the
                       <O.Record#saveToStore> method.
    */
    init: function (store, storeKey) {
        this._noSync = false;
        this._data = storeKey
            ? null
            : store
            ? {
                  accountId: store.getPrimaryAccountIdForType(this.constructor),
              }
            : {};
        this.store = store;
        this.storeKey = storeKey;

        Record.parent.constructor.call(this);
    },

    nextEventTarget: function () {
        return this.get('store');
    }
        .property()
        .nocache(),

    /**
        Method: O.Record#clone

        Creates a new instance of the record with the same attributes. Does
        not call <O.Record#saveToStore>.

        Parameters:
            store - {O.Store} The store to create the record in.

        Returns:
            {O.Record} The new record.
    */
    clone(store) {
        const Type = this.constructor;
        const prototype = Type.prototype;
        const recordClone = new Type(store);
        const attrs = meta(this).attrs;
        recordClone.set('accountId', this.get('accountId'));
        for (const attrKey in attrs) {
            const propKey = attrs[attrKey];
            if (prototype[propKey].noSync) {
                continue;
            }
            let value = this.get(propKey);
            if (value instanceof Record) {
                value = value.getDoppelganger(store);
            }
            if (value !== undefined) {
                recordClone.set(propKey, value);
            }
        }

        return recordClone;
    },

    /**
        Property: O.Record#store
        Type: O.Store

        The store this record is associated with.
    */

    /**
        Property: O.Record#storeKey
        Type: (String|undefined)

        The record store key; will be unique amonsgst all loaded records, even
        across those of different types.
    */

    // ---

    /**
        Property: O.Record#status
        Type: O.Status

        The status of this Record. A Record goes through three primary phases:
        EMPTY -> READY -> DESTROYED. Alternatively it may go EMPTY ->
        NON_EXISTENT. Whilst in these phases it may acquire other properties:
        LOADING, NEW, DIRTY, OBSOLETE. Each of the primary phases as well as the
        secondary properties are different bits in the status bitarray. You
        should check the condition by using bitwise operators with the constants
        defined in <O.Status>.
    */
    status: function () {
        const storeKey = this.get('storeKey');
        return storeKey
            ? this.get('store').getStatus(storeKey)
            : READY_NEW_DIRTY;
    }
        .property()
        .nocache(),

    /**
        Method: O.Record#is

        Checks whether record has a particular status. You can also supply a
        union of statuses (e.g. `record.is(O.Status.OBSOLETE|O.Status.DIRTY)`),
        in which case it will return true if the record has *any* of these
        status bits set.

        Parameters:
            state - {O.Status} The status to check.

        Returns:
            {Boolean} True if the record has the queried status.
    */
    is(state) {
        return !!(this.get('status') & state);
    },

    /**
        Method: O.Record#setObsolete

        Adds <O.Status.OBSOLETE> to the current status value.

        Returns:
            {O.Record} Returns self.
    */
    setObsolete() {
        const storeKey = this.get('storeKey');
        const status = this.get('status');
        if (storeKey) {
            this.get('store').setStatus(storeKey, status | OBSOLETE);
        }
        return this;
    },

    /**
        Method: O.Record#setLoading

        Adds <O.Status.LOADING> to the current status value.

        Returns:
            {O.Record} Returns self.
    */
    setLoading() {
        const storeKey = this.get('storeKey');
        const status = this.get('status');
        if (storeKey) {
            this.get('store').setStatus(storeKey, status | LOADING);
        }
        return this;
    },

    // ---

    /**
        Property: O.Record#id
        Type: String

        The record id. It's fine to override this with an attribute, provided it
        is the primary key. If the primary key for the record is not called
        'id', you must not override this property.
    */
    id: function (id) {
        const storeKey = this.get('storeKey');
        const primaryKey = this.constructor.primaryKey || 'id';
        if (id !== undefined) {
            if (storeKey) {
                didError({
                    name: 'O.Record#id',
                    message: 'Cannot change immutable property',
                });
            } else if (primaryKey === 'id') {
                this._data.id = id;
            } else {
                this.set(primaryKey, id);
            }
        }
        return storeKey
            ? this.get('store').getIdFromStoreKey(storeKey)
            : this._data[primaryKey];
    }.property('accountId'),

    toJSON() {
        return this.get('storeKey') || this;
    },

    toIdOrStoreKey() {
        return this.get('id') || '#' + this.get('storeKey');
    },

    accountId: function (toAccountId) {
        const storeKey = this.get('storeKey');
        const store = this.get('store');
        let accountId = storeKey
            ? store.getAccountIdFromStoreKey(storeKey)
            : this._data.accountId;
        if (toAccountId !== undefined && toAccountId !== accountId) {
            if (this.get('status') === READY_NEW_DIRTY) {
                if (storeKey) {
                    store.updateData(
                        storeKey,
                        {
                            accountId: toAccountId,
                        },
                        true,
                    );
                } else {
                    this._data.accountId = toAccountId;
                }
            } else {
                store.moveRecord(storeKey, toAccountId);
            }
            accountId = toAccountId;
            store.fire('record:user:update', { record: this });
        }
        return accountId;
    }.property(),

    /**
        Method: O.Record#saveToStore

        Saves the record to the store. Will then be committed back by the store
        according to the store's policy. Note, only a record not currently
        created in its store can do this; an error will be thrown if this method
        is called for a record already created in the store.

        Returns:
            {O.Record} Returns self.
    */
    saveToStore() {
        if (this.get('storeKey')) {
            throw new Error('Record already created in store.');
        }
        const Type = this.constructor;
        const data = this._data;
        const store = this.get('store');
        const accountId = this.get('accountId');
        const idPropKey = Type.primaryKey || 'id';
        const idAttrKey = this[idPropKey].key || idPropKey;
        const storeKey = store.getStoreKey(accountId, Type, data[idAttrKey]);
        const attrs = meta(this).attrs;

        this._data = null;

        // Fill in any missing defaults + toOne attributes to previously
        // uncreated records
        for (const attrKey in attrs) {
            const propKey = attrs[attrKey];
            if (propKey) {
                const attribute = this[propKey];
                if (!(attrKey in data)) {
                    const defaultValue = attribute.defaultValue;
                    if (defaultValue !== undefined) {
                        data[attrKey] = clone(defaultValue);
                    }
                } else if (
                    attribute instanceof ToOneAttribute &&
                    data[attrKey] instanceof Record
                ) {
                    data[attrKey] = data[attrKey].toJSON();
                }
            }
        }

        // Save to store
        store.createRecord(storeKey, data).setRecordForStoreKey(storeKey, this);

        // And save store reference on record instance.
        this.set('storeKey', storeKey);

        // Fire event
        store.fire('record:user:create', { record: this });

        return this;
    },

    /**
        Method: O.Record#discardChanges

        Reverts the attributes in the record to the last committed state. If
        the record has never been committed, this will destroy the record.

        Returns:
            {O.Record} Returns self.
    */
    discardChanges() {
        if (this.get('status') === READY_NEW_DIRTY) {
            this.destroy();
        } else {
            const storeKey = this.get('storeKey');
            if (storeKey) {
                this.get('store').revertData(storeKey);
            }
        }
        return this;
    },

    /**
        Method: O.Record#fetch

        Fetch/refetch the data from the source. Will have no effect if the
        record is new or already loading.

        Returns:
            {O.Record} Returns self.
    */
    fetch() {
        const storeKey = this.get('storeKey');
        if (storeKey) {
            this.get('store').fetchData(storeKey);
        }
        return this;
    },

    /**
        Method: O.Record#destroy

        Destroy the record. This will inform the store, which will commit it to
        the source.
    */
    destroy() {
        const storeKey = this.get('storeKey');
        if (storeKey && this.get('isEditable')) {
            this.get('store')
                .destroyRecord(storeKey)
                .fire('record:user:destroy', { record: this });
        } else if (!storeKey) {
            this.storeWillUnload();
        }
    },

    /**
        Method: O.Record#getDoppelganger

        Parameters:
            store - {O.Store} A store to get this event in.

        Returns:
            {O.Record} Returns the record instance for the same record in the
            given store.
    */
    getDoppelganger(store) {
        if (this.get('store') === store) {
            return this;
        }
        return store.materialiseRecord(this.get('storeKey'));
    },

    /**
        Method: O.Record#getData

        Returns:
            {Object} The raw data hash in the store for this object.
    */
    getData() {
        return this._data || this.get('store').getData(this.get('storeKey'));
    },

    /**
        Method: O.Record#storeWillUnload

        This should only be called by the store, when it unloads the record's
        data to free up memory.
    */
    storeWillUnload() {
        Record.parent.destroy.call(this);
    },

    /**
        Property (private): O.Record#_noSync
        Type: Boolean

        If true, any changes to the record will not be committed to the source.
    */

    /**
        Method: O.Record#stopSync

        Any changes after this has been invoked will not by synced to the
        source.

        Returns:
            {O.Record} Returns self.
    */
    stopSync() {
        this._noSync = true;
        return this;
    },

    /**
        Method: O.Record#startSync

        If syncing has been stopped by a call to <O.Record#stopSync>, this
        will then enable it again for any *future* changes.

        Returns:
            {O.Record} Returns self.
    */
    startSync() {
        this._noSync = false;
        return this;
    },

    /**
        Property: O.Record#isEditable
        Type: Boolean
        Default: True

        May the record be edited/deleted?
    */
    isEditable: true,

    // ---

    AttributeErrorsType: AttributeErrors,

    /**
        Property: O.Record#isValid
        Type: Boolean

        Are all the attributes are in a valid state?
    */
    isValid: function (value) {
        return value !== undefined
            ? value
            : !this.get('errorForAttribute').get('errorCount');
    }.property(),

    /**
        Method: O.Record#errorToSet

        Checks whether it will be an error to set the attribute with the given
        key to the given value. If it will be an error, the string describing
        the error is returned, otherwise an empty string is returned.

        Parameters:
            key   - {String} The name of the attribute.
            value - {*} The proposed value to set it to.

        Returns:
            {O.ValidationError|null} The error, or null if the assignment would
            be valid.
    */
    errorToSet(key, value) {
        const attr = this[key];
        return attr.validate ? attr.validate(value, key, this) : null;
    },

    /**
        Property: O.Record#errorForAttribute
        Type: O.Object

        Calling get() with the key for an attribute on this record will return
        an error string if the currently set value is invalid, or an empty
        string if the attribute is currently valid. You can bind to the
        properties on this object.
    */
    errorForAttribute: function () {
        const AttributeErrorsType = this.get('AttributeErrorsType');
        return new AttributeErrorsType(this);
    }.property(),

    /**
        Method: O.Record#notifyAttributeErrors
    */
    notifyAttributeErrors(_, propKey) {
        const attributeErrors = meta(this).cache.errorForAttribute;
        if (attributeErrors) {
            attributeErrors.recordPropertyDidChange(this, propKey);
        }
    },

    // ---

    /**
        Method: O.Record#getResult
        Returns: {Promise<O.RecordResult>}

        The promise it returns will resolve to a RecordResult which has two
        notable properties, `record` and `error`.

        Normally, <O.Record#ifSuccess> will be easier to use, but if you’re
        working with batch processing of objects and Promise.all(), then you’ll
        want to use getResult rather than ifSuccess, because Promise.all() will
        reject with the first error it receives, whereas in such a situation
        you’ll want instead to produce an array of errors.

        Usage:

            record
                .set( … )  // Or anything that makes it commit changes.
                .getResult({
                    handledErrorTypes: [ 'somethingWrong' ],
                })
                .then( result => {
                    if ( result.error ) {
                        // Do something with the somethingWrong error
                    }
                });
    */
    getResult(mixin) {
        return new Promise((resolve) => new RecordResult(this, resolve, mixin));
    },

    /**
        Method: O.Record#ifSuccess
        Returns: {Promise<O.Record, O.RecordResult>}

        The promise it returns will either resolve to the record, or be rejected
        with a RecordResult, which is an object containing two properties to
        care about, `record` and `error`.

        (Why the name ifSuccess? Read it as “set this field; if success, then do
        such-and-such, otherwise catch so-and-so.)

        Usage for catching failed commits:

            record
                .set( … )  // Or anything that makes it commit changes.
                .ifSuccess({
                    handledErrorTypes: [ 'somethingWrong' ],
                })
                .then( record => {
                    // Do something after the commit has finished
                })
                .catch( ({ record, error }) => {
                    // Do something with the somethingWrong error
                });

        Or for loading a record that may or may not exist:

            store
                .getRecord( null, Foo, 'id' )
                .ifSuccess()
                    .then( record => {
                        // record loaded
                    })
                    .catch( ({ record }) => {
                        // record didn't load
                    })

    */
    ifSuccess(mixin) {
        return promisifyResult(this, mixin);
    },

    /**
        Method: O.Record#ifLoaded
        Returns: {Promise<O.Record|O.RecordResult>}

        The promise returned will either resolve to the record when it has
        finished loading, or be rejected with a RecordResult, which is an object 
        containing two properties to care about, `record` and `error`.

        This is useful when calling <O.Record#fetch> on an <O.Record> that has
        already been marked `READY` and are expecting changes as a result of the
        fetch request.
     */
    ifLoaded(mixin) {
        return promisifyResult(this, {
            statusDidChange(_, __, ___, newStatus) {
                if (!(newStatus & LOADING)) {
                    this.done();
                }
            },
            ...mixin,
        });
    },
});

function promisifyResult(record, mixin) {
    return new Promise(
        (resolve, reject) =>
            new RecordResult(
                record,
                (result) => {
                    const _record = result.record;
                    if (result.error || _record.is(NON_EXISTENT)) {
                        reject(result);
                    } else {
                        resolve(_record);
                    }
                },
                mixin,
            ),
    );
}

Record.getClientSettableAttributes = function (Type) {
    let clientSettableAttributes = Type.clientSettableAttributes;
    if (!clientSettableAttributes) {
        const prototype = Type.prototype;
        const attrs = meta(prototype).attrs;
        clientSettableAttributes = {};
        for (const attrKey in attrs) {
            const propKey = attrs[attrKey];
            if (propKey) {
                const attribute = prototype[propKey];
                if (!attribute.noSync) {
                    clientSettableAttributes[attrKey] = true;
                }
            }
        }
        Type.clientSettableAttributes = clientSettableAttributes;
    }
    return clientSettableAttributes;
};

/**
    Property: O.Record.primaryKey
    Type: String

    Set automatically by the O.RecordAttribute with `isPrimaryKey: true`. If
    no primary key is set, there is presumed to be a property called "id"
    that is the primary key.
*/

export { Record };
