import { Class, clone, guid, isEqual, meta } from '../../core/Core.js';
import { filter as filterObject, keyOf, zip } from '../../core/KeyValue.js';
import { Event } from '../../foundation/Event.js';
import { EventTarget } from '../../foundation/EventTarget.js';
import { Obj } from '../../foundation/Object.js';
import { didError, queueFn } from '../../foundation/RunLoop.js';
import { RecordArray } from '../query/RecordArray.js';
import { Record } from '../record/Record.js';
import {
    COMMITTING, // Request in progress to commit record
    DESTROYED,
    DIRTY, // Record has local changes not yet committing
    // Core states:
    EMPTY,
    // Properties:
    LOADING, // Request in progress to fetch record or updates
    NEW, // Record is not created on source (has no source id)
    NON_EXISTENT,
    OBSOLETE, // Record may have changes not yet loaded
    READY,
} from '../record/Status.js';
// eslint-disable-next-line no-duplicate-imports, import/no-namespace
import * as Status from '../record/Status.js';
import { ToManyAttribute } from '../record/toMany.js';
import { ToOneAttribute } from '../record/toOne.js';

import '../../core/Array.js'; // For Array#erase

/**
    Module: DataStore

    The DataStore module provides classes for managing the CRUD lifecycle of
    data records.
*/

// ---

// Error messages.
const CANNOT_CREATE_EXISTING_RECORD_ERROR =
    'O.Store Error: Cannot create existing record';
const CANNOT_WRITE_TO_UNREADY_RECORD_ERROR =
    'O.Store Error: Cannot write to unready record';
const SOURCE_COMMIT_CREATE_MISMATCH_ERROR =
    'O.Store Error: Source committed a create on a record not marked new';
const SOURCE_COMMIT_DESTROY_MISMATCH_ERROR =
    'O.Store Error: Source commited a destroy on a record not marked destroyed';

// ---

let nextStoreKey = 1;
const generateStoreKey = function () {
    const current = 'k' + nextStoreKey;
    nextStoreKey += 1;
    return current;
};

// ---

const mayHaveChanges = function (store) {
    queueFn('before', store.checkForChanges, store);
    return store;
};

// ---

const acceptStoreKey = function (accept, storeKey) {
    return accept(this._skToData[storeKey], this, storeKey);
};

const compareStoreKeys = function (compare, a, b) {
    const { _skToData } = this;
    const aIsFirst = compare(_skToData[a], _skToData[b], this, a, b);
    return aIsFirst || ~~a.slice(1) - ~~b.slice(1);
};

// ---

const STRING_ID = 0;
const ARRAY_IDS = 1;
const SET_IDS = 2;

const typeToForeignRefAttrs = {};

const getForeignRefAttrs = function (Type) {
    const typeId = guid(Type);
    let foreignRefAttrs = typeToForeignRefAttrs[typeId];
    if (!foreignRefAttrs) {
        const proto = Type.prototype;
        const attrs = meta(proto).attrs;
        foreignRefAttrs = [];
        for (const attrKey in attrs) {
            const propKey = attrs[attrKey];
            const attribute = propKey && proto[propKey];
            if (attribute instanceof ToOneAttribute) {
                foreignRefAttrs.push([attrKey, STRING_ID, attribute.Type]);
            }
            if (attribute instanceof ToManyAttribute) {
                foreignRefAttrs.push([
                    attrKey,
                    attribute.Type === Object ? SET_IDS : ARRAY_IDS,
                    attribute.recordType,
                ]);
            }
        }
        typeToForeignRefAttrs[typeId] = foreignRefAttrs;
    }
    return foreignRefAttrs;
};

const convertForeignKeysToSK = function (
    store,
    foreignRefAttrs,
    data,
    accountId,
) {
    const l = foreignRefAttrs.length;
    for (let i = 0; i < l; i += 1) {
        const foreignRef = foreignRefAttrs[i];
        const attrKey = foreignRef[0];
        const AttrType = foreignRef[2];
        const idType = foreignRef[1];
        if (attrKey in data) {
            const value = data[attrKey];
            data[attrKey] =
                value &&
                (idType === STRING_ID
                    ? store.getStoreKey(accountId, AttrType, value)
                    : idType === ARRAY_IDS
                    ? value.map(
                          store.getStoreKey.bind(store, accountId, AttrType),
                      )
                    : // idType === SET_IDS ?
                      zip(
                          Object.keys(value).map(
                              store.getStoreKey.bind(
                                  store,
                                  accountId,
                                  AttrType,
                              ),
                          ),
                          Object.values(value),
                      ));
        }
    }
};

const toId = function (store, storeKey) {
    return store.getIdFromStoreKey(storeKey) || '#' + storeKey;
};

const convertForeignKeysToId = function (store, Type, data) {
    const foreignRefAttrs = getForeignRefAttrs(Type);
    let result = data;
    const l = foreignRefAttrs.length;
    for (let i = 0; i < l; i += 1) {
        const foreignRef = foreignRefAttrs[i];
        const attrKey = foreignRef[0];
        const idType = foreignRef[1];
        if (attrKey in data) {
            if (result === data) {
                result = clone(data);
            }
            const value = data[attrKey];
            result[attrKey] =
                value &&
                (idType === STRING_ID
                    ? toId(store, value)
                    : idType === ARRAY_IDS
                    ? value.map(toId.bind(null, store))
                    : // idType === SET_IDS ?
                      zip(
                          Object.keys(value).map(toId.bind(null, store)),
                          Object.values(value),
                      ));
        }
    }
    return result;
};

// ---

const getChanged = function (Type, a, b) {
    const changed = {};
    const clientSettable = Record.getClientSettableAttributes(Type);
    let hasChanges = false;
    for (const key in a) {
        if (clientSettable[key] && !isEqual(a[key], b[key])) {
            changed[key] = true;
            hasChanges = true;
        }
    }
    return hasChanges ? changed : null;
};

const getDelta = function (Type, data, changed) {
    const proto = Type.prototype;
    const attrs = meta(proto).attrs;
    const delta = {};
    for (const attrKey in changed) {
        if (changed[attrKey]) {
            let value = data[attrKey];
            if (value === undefined) {
                value = proto[attrs[attrKey]].defaultValue;
            }
            delta[attrKey] = value;
        }
    }
    return delta;
};

// ---

/**
    Class: O.Store

    A Store is used to keep track of all records in the model. It provides
    methods for retrieving single records or lists based on queries.

    Principles:
    * Records are never locked: you can always edit or destroy a READY record,
      even when it is committing another change.
    * A record never has more than one change in flight to the server at once.
      If it is currently committing, any further change must wait for the
      previous commit to succeed/fail before being committed to the server.
    * A record is always in exactly one of the core states:
      - `EMPTY`: No information is known about the record.
      - `READY`: The record is loaded in memory. You may read, update or
        destroy it.
      - `DESTROYED`: The record has been destroyed. (This may not have been
        committed to the server yet; see below).
      - `NON_EXISTENT`: No record with the requested id exists.
    * A record may additionally have one or more of the following status bits
      set:
      - `LOADING`: A request is in progress to fetch the record's data
        (or update the data if the record is already in memory).
      - `COMMITTING`: A request is in progress to commit a change to the record.
      - `NEW`: The record is not yet created on the source (and therefore has
         no source id).
      - `DIRTY`: The record has local changes not yet committing.
      - `OBSOLETE`: The record may have changes on the server not yet loaded.
*/
const Store = Class({
    Name: 'Store',

    Extends: Obj,

    /**
        Property: O.Store#autoCommit
        Type: Boolean
        Default: true

        If true, the store will automatically commit any changes at the end of
        the RunLoop in which they are made.
    */
    autoCommit: true,

    /**
        Property: O.Store#rebaseConflicts
        Type: Boolean
        Default: true

        If true, in the event that new data is loaded for a dirty record, the
        store will apply the changes made to the previous committed state on top
        of the current committed state, rather than just discarding the changes.
    */
    rebaseConflicts: true,

    /**
        Property: O.Store#isNested
        Type: Boolean

        Is this a nested store?
    */
    isNested: false,

    /**
        Property: O.Store#hasChanges
        Type: Boolean

        Are there any changes in the store?
    */

    /**
        Constructor: O.Store

        Parameters:
            ...mixins - {Object} Objects to mix in, which must include a
                        parameter named `source` of type {O.Source}, the source
                        for this store.
    */
    init: function (/* ...mixins */) {
        // Map Type -> store key -> id
        this._typeToSKToId = {};
        // Map store key -> accountId
        this._skToAccountId = {};
        // Map store key -> Type
        this._skToType = {};
        // Map store key -> status
        this._skToStatus = {};
        // Map store key -> data
        this._skToData = {};
        // Map store key -> object with `true` for each changed property
        this._skToChanged = {};
        // Map store key -> last committed data (when changed)
        this._skToCommitted = {};
        // Map store key -> last committed data (when committing)
        this._skToRollback = {};
        // Map store key -> record
        this._skToRecord = {};
        // Map store key -> last access timestamp for memory manager
        this._skToLastAccess = {};

        // Any changes waiting to be committed?
        this.hasChanges = false;
        // Flag if committing
        this.isCommitting = false;
        // Set of store keys for created records
        this._created = {};
        // Set of store keys for destroyed records
        this._destroyed = {};

        // Map id -> query
        this._idToQuery = {};
        // Set of types that have had data changed during this run loop
        this._changedTypes = {};

        // List of nested stores
        this._nestedStores = [];

        // Map accountId -> { status, clientState, serverState }
        // (An account MUST be added before attempting to use the store.)
        this._accounts = {};

        Store.parent.constructor.apply(this, arguments);

        if (!this.get('isNested')) {
            this.source.set('store', this);
        }
    },

    // === Nested Stores =======================================================

    /**
        Method: O.Store#addNested

        Registers a new nested store. Automatically called by the
        <O.NestedStore> constructor; there should be no need to do it manually.

        Parameters:
            store - {O.NestedStore} The new nested store.

        Returns:
            {O.Store} Returns self.
    */
    addNested(store) {
        this._nestedStores.push(store);
        return this;
    },

    /**
        Method: O.Store#removeNested

        Deregisters a nested store previously registered with addNested.
        Automatically called by <O.NestedStore#destroy>; there should be no need
        to call this method manually.

        Parameters:
            store - {O.NestedStore} The nested store to deregister.

        Returns:
            {O.Store} Returns self.

    */
    removeNested(store) {
        this._nestedStores.erase(store);
        return this;
    },

    // === Accounts ============================================================

    /**
        Method: O.Store#getPrimaryAccountIdForType

        Get the default account ID for the specified type.

        The default implementation of this method basically doesn’t support the
        concept of a default accountId; accountId must always be specified, or
        this method will be called and throw a TypeError. This method is
        designed to be overridden, straight on the O.Store prototype. (Yes,
        that’s nasty. Sorry; c’est la vie.)

        Parameters:
            Type - {class extending O.Record}

        Returns:
            {string} Returns the primary accountId for data of that type.
    */
    getPrimaryAccountIdForType(/* Type */) {
        throw new TypeError('accountId cannot be inferred');
    },

    /**
        Method: O.Store#getAccount

        Get the account for the given account ID, or if it is not specified, the
        primary account for the given type.

        Parameters:
            accountId - {(string|undefined|null)}
            Type - {(class extending O.Record|undefined)}

        Returns:
            {(Object|undefined)} Returns the account data, or undefined if
                                 there’s not enough to go by or the details
                                 given don’t resolve to an account.
    */
    getAccount(accountId, Type) {
        if (!accountId) {
            accountId = this.getPrimaryAccountIdForType(Type);
        }
        return this._accounts[accountId];
    },

    addAccount(accountId, data) {
        const _accounts = this._accounts;
        // replaceAccountId is intended for situations where you wish to
        // retrieve a record that should be broadly considered a global, before
        // you have loaded the accounts. This way, you can add a dummy account,
        // get those records from the dummy account, and then when you have the
        // accounts, silently update the accountId to the real value. That way
        // you can still handle all of your bindings declaratively, rather than
        // having to wait until you have loaded the accounts.
        const replaceAccountId = data.replaceAccountId;
        let account;
        if (replaceAccountId && (account = _accounts[replaceAccountId])) {
            if (data.accountCapabilities) {
                account.accountCapabilities = data.accountCapabilities;
            }
            const skToAccountId = this._skToAccountId;
            for (const sk in skToAccountId) {
                if (skToAccountId[sk] === replaceAccountId) {
                    skToAccountId[sk] = accountId;
                }
            }
            delete _accounts[replaceAccountId];
        } else if (!(account = _accounts[accountId])) {
            account = {
                accountCapabilities: data.accountCapabilities,
                // Type -> status
                // READY      - Some records of type loaded
                // LOADING    - Loading or refreshing ALL records of type
                // COMMITTING - Committing some records of type
                status: {},
                // Type -> Promise. Resolved (and cleared) when
                // type becomes READY.
                awaitingReadyPromise: {},
                // Type -> Function (promise resolver). Called when
                // type becomes READY.
                awaitingReadyResolve: {},
                // Type -> state string for type in client
                clientState: {},
                // Type -> latest known state string for type on server
                // If committing or loading type, wait until finish to check
                serverState: {},
                // Type -> id -> store key
                typeToIdToSK: {},
                // Clients can set this to true while doing a batch of changes
                // to avoid fetching updates to related types during the process
                ignoreServerState: false,
            };
        }
        _accounts[accountId] = account;

        return this;
    },

    // === Get/set Ids =========================================================

    /**
        Method: O.Store#getStoreKey

        Returns the store key for a particular record type and record id. This
        is guaranteed to be the same for that tuple until the record is unloaded
        from the store. If no id is supplied, a new store key is always
        returned.

        Parameters:
            accountId - {String|null} The account to use, or null for default.
            Type      - {O.Class} The constructor for the record type.
            id        - {String} (optional) The id of the record.

        Returns:
            {String} Returns the store key for that record type and id.
    */
    getStoreKey(accountId, Type, id) {
        if (!accountId) {
            accountId = this.getPrimaryAccountIdForType(Type);
        }
        const account = this._accounts[accountId];
        const typeId = guid(Type);
        const typeToIdToSK = account.typeToIdToSK;
        const idToSk = typeToIdToSK[typeId] || (typeToIdToSK[typeId] = {});
        let storeKey;

        if (id) {
            storeKey = idToSk[id];
        }
        if (!storeKey) {
            storeKey = generateStoreKey();
            this._skToType[storeKey] = Type;
            this._skToAccountId[storeKey] = accountId;
            const { _typeToSKToId } = this;
            const skToId =
                _typeToSKToId[typeId] || (_typeToSKToId[typeId] = {});
            skToId[storeKey] = id;
            if (id) {
                idToSk[id] = storeKey;
            }
        }

        return storeKey;
    },

    /**
        Method: O.Store#getIdFromStoreKey

        Get the record id for a given store key.

        Parameters:
            storeKey - {String} The store key to get the record id for.

        Returns:
            {(String|null)} Returns the id for the record, or null if the store
            key was not found or does not have an id (normally because the
            server assigns ids and the record has not yet been committed).
    */
    getIdFromStoreKey(storeKey) {
        const status = this._skToStatus[storeKey];
        const Type = this._skToType[storeKey];
        const skToId = this._typeToSKToId[guid(Type)];
        return (!(status & NEW) && skToId && skToId[storeKey]) || null;
    },

    /**
        Method: O.Store#getAccountIdFromStoreKey

        Get the account id for a given store key.

        Parameters:
            storeKey - {String} The store key to get the account id for.

        Returns:
            {(String)} Returns the id of the account the record belongs to.
    */
    getAccountIdFromStoreKey(storeKey) {
        const data = this._skToData[storeKey];
        return data ? data.accountId : this._skToAccountId[storeKey];
    },

    // === Client API ==========================================================

    /**
        Method: O.Store#getRecordStatus

        Returns the status value for a given record type and id.

        Parameters:
            accountId - {String|null} The account id.
            Type      - {O.Class} The record type.
            id        - {String} The record id.

        Returns:
            {O.Status} The status in this store of the given record.
    */
    getRecordStatus(accountId, Type, id) {
        const idToSk = this.getAccount(accountId, Type).typeToIdToSK[
            guid(Type)
        ];
        return idToSk ? this.getStatus(idToSk[id]) : EMPTY;
    },

    /**
        Method: O.Store#getRecord

        Returns a record object for a particular type and id, creating it if it
        does not already exist and fetching its value if not already loaded in
        memory, unless the doNotFetch parameter is set.

        Parameters:
            accountId  - {String|null} The account id.
            Type       - {O.Class} The record type.
            id         - {String} The record id, or the store key prefixed with
                         a '#'.
            doNotFetch - {Boolean} (optional) If true, the record data will not
                         be fetched from the server if it is not already loaded.

        Returns:
            {O.Record|null} Returns the requested record, or null if no type or
            no id given.
    */
    getRecord(accountId, Type, id, doNotFetch) {
        let storeKey;
        if (!Type || !id) {
            return null;
        }
        if (id.charAt(0) === '#') {
            storeKey = id.slice(1);
            if (this._skToType[storeKey] !== Type) {
                return null;
            }
        } else {
            storeKey = this.getStoreKey(accountId, Type, id);
        }
        return this.getRecordFromStoreKey(storeKey, doNotFetch);
    },

    /**
        Method: O.Store#getOne

        Returns the first loaded record that matches an acceptance function.

        Parameters:
            Type   - {O.Class} The constructor for the record type to find.
            filter - {Function} (optional) An acceptance function. This will be
                     passed the raw data object (*not* a record instance) and
                     should return true if the record is the desired one, or
                     false otherwise.

        Returns:
            {(O.Record|null)} The matching record, or null if none found.
    */
    getOne(Type, filter) {
        const storeKey = this.findOne(Type, filter);
        return storeKey ? this.materialiseRecord(storeKey) : null;
    },

    /**
        Method: O.Store#getAll

        Returns a record array of records with data loaded for a particular
        type, optionally filtered and/or sorted.

        Parameters:
            Type   - {O.Class} The constructor for the record type being
                     queried.
            filter - {Function} (optional) An acceptance function. This will be
                     passed the raw data object (*not* a record instance) and
                     should return true if the record should be included, or
                     false otherwise.
            sort   - {Function} (optional) A comparator function. This will be
                     passed the raw data objects (*not* record instances) for
                     two records. It should return -1 if the first record should
                     come before the second, 1 if the inverse is true, or 0 if
                     they should have the same position.

        Returns:
            {O.RecordArray} A record array of results.
    */
    getAll(Type, filter, sort) {
        const storeKeys = this.findAll(Type, filter, sort);
        return new RecordArray(this, Type, storeKeys);
    },

    checkForChanges() {
        let storeKey;
        for (storeKey in this._created) {
            return this.set('hasChanges', true);
        }
        for (storeKey in this._skToChanged) {
            return this.set('hasChanges', true);
        }
        for (storeKey in this._destroyed) {
            return this.set('hasChanges', true);
        }
        return this.set('hasChanges', false);
    },

    hasChangesForType(Type) {
        const { _created, _destroyed, _skToChanged, _skToType } = this;
        for (const storeKey in _created) {
            if (Type === _skToType[storeKey]) {
                return true;
            }
        }
        for (const storeKey in _skToChanged) {
            if (Type === _skToType[storeKey]) {
                return true;
            }
        }
        for (const storeKey in _destroyed) {
            if (Type === _skToType[storeKey]) {
                return true;
            }
        }
        return false;
    },

    /**
        Method: O.Store#commitChanges

        Commits any outstanding changes (created/updated/deleted records) to the
        source. Will only invoke once per run loop, even if called multiple
        times.

        Returns:
            {O.Store} Returns self.
    */
    commitChanges: function () {
        // Don't commit if another commit is already in progress. We can't
        // reference a foreign ID if it is currently being created in an
        // inflight request. We also need the new state string for commits
        // to a particular type to make sure we don't miss any changes.
        // We'll automatically commit again if there are any changes when the
        // current commit finishes.
        if (this.get('isCommitting')) {
            return;
        }
        this.set('isCommitting', true);

        this.fire('willCommit');
        const {
            _typeToSKToId,
            _skToData,
            _skToStatus,
            _skToType,
            _skToChanged,
            _skToCommitted,
            _skToRollback,
            _created,
            _destroyed,
            _accounts,
        } = this;

        const changes = {};
        let hasChanges = false;

        const getEntry = function (Type, accountId) {
            const typeId = guid(Type);
            let entry = changes[typeId + accountId];
            if (!entry) {
                const account = _accounts[accountId];
                const idPropKey = Type.primaryKey || 'id';
                const idAttrKey = Type.prototype[idPropKey].key || idPropKey;
                entry = changes[typeId + accountId] = {
                    Type,
                    typeId,
                    accountId,
                    primaryKey: idAttrKey,
                    create: { storeKeys: [], records: [] },
                    update: {
                        storeKeys: [],
                        records: [],
                        committed: [],
                        changes: [],
                    },
                    moveFromAccount: {},
                    destroy: { storeKeys: [], ids: [] },
                    state: account.clientState[typeId],
                };
                account.status[typeId] |= COMMITTING;
                hasChanges = true;
            }
            return entry;
        };

        for (const storeKey in _created) {
            const isCopyOfStoreKey = _created[storeKey];
            const status = _skToStatus[storeKey];
            const Type = _skToType[storeKey];
            let data = _skToData[storeKey];
            const accountId = data.accountId;
            const entry = getEntry(Type, accountId);
            let create;

            if (isCopyOfStoreKey) {
                const changed = getChanged(
                    Type,
                    data,
                    _skToData[isCopyOfStoreKey],
                );
                data = convertForeignKeysToId(this, Type, data);
                const previousAccountId =
                    this.getAccountIdFromStoreKey(isCopyOfStoreKey);
                create =
                    entry.moveFromAccount[previousAccountId] ||
                    (entry.moveFromAccount[previousAccountId] = {
                        copyFromIds: [],
                        storeKeys: [],
                        records: [],
                        changes: [],
                    });
                create.copyFromIds.push(
                    this.getIdFromStoreKey(isCopyOfStoreKey),
                );
                create.changes.push(changed);
            } else {
                data = filterObject(
                    convertForeignKeysToId(this, Type, data),
                    Record.getClientSettableAttributes(Type),
                );
                create = entry.create;
            }

            create.storeKeys.push(storeKey);
            create.records.push(data);
            this.setStatus(storeKey, (status & ~DIRTY) | COMMITTING);
        }
        for (const storeKey in _skToChanged) {
            const status = _skToStatus[storeKey];
            const Type = _skToType[storeKey];
            const changed = filterObject(
                _skToChanged[storeKey],
                Record.getClientSettableAttributes(Type),
            );

            let previous = _skToCommitted[storeKey];
            delete _skToCommitted[storeKey];
            // If all updates for a record are to noSync attributes, don't
            // commit update to source
            if (!Object.keys(changed).length) {
                this.setStatus(storeKey, status & ~DIRTY);
                continue;
            }
            let data = _skToData[storeKey];
            const accountId = data.accountId;
            const update = getEntry(Type, accountId).update;

            _skToRollback[storeKey] = previous;
            previous = convertForeignKeysToId(this, Type, previous);
            data = convertForeignKeysToId(this, Type, data);

            update.storeKeys.push(storeKey);
            update.records.push(data);
            update.committed.push(previous);
            update.changes.push(changed);
            this.setStatus(storeKey, (status & ~DIRTY) | COMMITTING);
        }
        for (const storeKey in _destroyed) {
            const status = _skToStatus[storeKey];
            const ifCopiedStoreKey = _destroyed[storeKey];
            // Check if already handled by moveFromAccount in create.
            if (!ifCopiedStoreKey || !_created[ifCopiedStoreKey]) {
                const Type = _skToType[storeKey];
                const accountId = _skToData[storeKey].accountId;
                const id = _typeToSKToId[guid(Type)][storeKey];
                const destroy = getEntry(Type, accountId).destroy;

                destroy.storeKeys.push(storeKey);
                destroy.ids.push(id);
            }
            this.setStatus(storeKey, (status & ~DIRTY) | COMMITTING);
        }

        this._skToChanged = {};
        this._created = {};
        this._destroyed = {};

        if (hasChanges) {
            this.source.commitChanges(changes, () => {
                for (const id in changes) {
                    const entry = changes[id];
                    const Type = entry.Type;
                    const typeId = entry.typeId;
                    const accountId = entry.accountId;
                    _accounts[accountId].status[typeId] &= ~COMMITTING;
                    this.checkServerState(accountId, Type);
                }
                this.set('isCommitting', false);
                if (
                    this.get('autoCommit') &&
                    this.checkForChanges().get('hasChanges')
                ) {
                    this.commitChanges();
                }
            });
        } else {
            this.set('isCommitting', false);
        }

        this.set('hasChanges', false);
        this.fire('didCommit');
    }.queue('middle'),

    /**
        Method: O.Store#discardChanges

        Discards any outstanding changes (created/updated/deleted records),
        reverting the store to the last known committed state.

        Returns:
            {O.Store} Returns self.
    */
    discardChanges() {
        const {
            _created,
            _destroyed,
            _skToChanged,
            _skToCommitted,
            _skToType,
            _skToData,
        } = this;

        for (const storeKey in _created) {
            this.destroyRecord(storeKey);
        }
        for (const storeKey in _skToChanged) {
            this.updateData(storeKey, _skToCommitted[storeKey], true);
        }
        for (const storeKey in _destroyed) {
            this.undestroyRecord(
                storeKey,
                _skToType[storeKey],
                _skToData[storeKey],
            );
        }

        this._created = {};
        this._destroyed = {};

        return this.set('hasChanges', false);
    },

    getInverseChanges() {
        const {
            _created,
            _destroyed,
            _skToType,
            _skToData,
            _skToChanged,
            _skToCommitted,
        } = this;
        const inverse = {
            create: [],
            update: [],
            destroy: [],
            move: [],
        };

        for (const storeKey in _created) {
            if (!_created[storeKey]) {
                inverse.destroy.push(storeKey);
            } else {
                const previousStoreKey = _created[storeKey];
                inverse.move.push([
                    storeKey,
                    this.getAccountIdFromStoreKey(previousStoreKey),
                    previousStoreKey,
                ]);
                inverse.update.push([
                    previousStoreKey,
                    getDelta(
                        _skToType[storeKey],
                        _skToData[previousStoreKey],
                        getChanged(
                            _skToType[storeKey],
                            _skToData[previousStoreKey],
                            _skToData[storeKey],
                        ),
                    ),
                ]);
            }
        }
        for (const storeKey in _skToChanged) {
            const committed = _skToCommitted[storeKey];
            const changed = _skToChanged[storeKey];
            const Type = _skToType[storeKey];
            const update = getDelta(Type, committed, changed);
            inverse.update.push([storeKey, update]);
        }
        for (const storeKey in _destroyed) {
            if (!_destroyed[storeKey]) {
                const Type = _skToType[storeKey];
                inverse.create.push([
                    storeKey,
                    Type,
                    clone(_skToData[storeKey]),
                ]);
            }
        }

        return inverse;
    },

    applyChanges(changes) {
        const create = changes.create;
        const update = changes.update;
        const destroy = changes.destroy;
        const move = changes.move;

        for (let i = 0, l = create.length; i < l; i += 1) {
            const createObj = create[i];
            const storeKey = createObj[0];
            const Type = createObj[1];
            const data = createObj[2];
            this.undestroyRecord(storeKey, Type, data);
        }
        for (let i = 0, l = move.length; i < l; i += 1) {
            const moveObj = move[i];
            const storeKey = moveObj[0];
            const toAccountId = moveObj[1];
            const previousStoreKey = moveObj[2];
            this.moveRecord(storeKey, toAccountId, previousStoreKey);
        }
        for (let i = 0, l = update.length; i < l; i += 1) {
            const updateObj = update[i];
            const storeKey = updateObj[0];
            const data = updateObj[1];
            this.updateData(storeKey, data, true);
        }
        for (let i = 0, l = destroy.length; i < l; i += 1) {
            const storeKey = destroy[i];
            this.destroyRecord(storeKey);
        }
    },

    // === Low level (primarily internal) API: uses storeKey ===================

    /**
        Method: O.Store#getTypeStatus

        Get the status of a type

        Parameters:
            accountId - {String|null} The account id.
            Type      - {O.Class} The record type.

        Returns:
            {O.Status} The status of the type in the store.
    */
    getTypeStatus(accountId, Type) {
        if (!Type) {
            const _accounts = this._accounts;
            let status = 0;
            Type = accountId;
            for (accountId in _accounts) {
                status |= this.getTypeStatus(accountId, Type);
            }
            return status;
        }
        return this.getAccount(accountId, Type).status[guid(Type)] || EMPTY;
    },

    whenTypeReady(accountId, Type) {
        if (!Type) {
            Type = accountId;
            accountId = this.getPrimaryAccountIdForType(Type);
        }
        if (this.getTypeStatus(accountId, Type) & READY) {
            return Promise.resolve();
        } else {
            const account = this._accounts[accountId];
            const awaitingReadyPromise = account.awaitingReadyPromise;
            const typeId = guid(Type);
            return (
                awaitingReadyPromise[typeId] ||
                (awaitingReadyPromise[typeId] = new Promise((resolve) => {
                    account.awaitingReadyResolve[typeId] = resolve;
                }))
            );
        }
    },

    /**
        Method: O.Store#getTypeState

        Get the current client state token for a type.

        Parameters:
            accountId - {String|null} The account id.
            Type      - {O.Class} The record type.

        Returns:
            {String|null} The client's current state token for the type.
    */
    getTypeState(accountId, Type) {
        return this.getAccount(accountId, Type).clientState[guid(Type)] || null;
    },

    /**
        Method: O.Store#getStatus

        Get the status of a record with a given store key.

        Parameters:
            storeKey - {String} The store key of the record.

        Returns:
            {O.Status} The status of the record with that store key.
    */
    getStatus(storeKey) {
        return this._skToStatus[storeKey] || EMPTY;
    },

    /**
        Method: O.Store#setStatus

        Set the status of a record with a given store key.

        Parameters:
            storeKey - {String} The store key of the record.
            status   - {O.Status} The new status for the record.

        Returns:
            {O.Store} Returns self.
    */
    setStatus(storeKey, status) {
        const previousStatus = this.getStatus(storeKey);
        const record = this._skToRecord[storeKey];
        if (previousStatus !== status) {
            this._skToStatus[storeKey] = status;
            // wasReady !== isReady
            if ((previousStatus ^ status) & READY) {
                this._recordDidChange(storeKey);
            }
            if (record) {
                record.propertyDidChange('status', previousStatus, status);
            }
            this._nestedStores.forEach((store) => {
                store.parentDidChangeStatus(storeKey, previousStatus, status);
            });
        }
        return this;
    },

    /**
        Method: O.Store#getRecordFromStoreKey

        Returns a record object for a particular store key, creating it if it
        does not already exist and fetching its value if not already loaded in
        memory, unless the doNotFetch parameter is set.

        Parameters:
            storeKey   - {String} The record store key.
            doNotFetch - {Boolean} (optional) If true, the record data will not
                         be fetched from the server if it is not already loaded.

        Returns:
            {O.Record} Returns the requested record.
    */
    getRecordFromStoreKey(storeKey, doNotFetch) {
        const record = this.materialiseRecord(storeKey);
        // If the caller is already handling the fetching, they can
        // set doNotFetch to true.
        if (!doNotFetch && this.getStatus(storeKey) === EMPTY) {
            this.fetchData(storeKey);
        }
        // Add timestamp for memory manager.
        this._skToLastAccess[storeKey] = Date.now();
        return record;
    },

    /**
        Method: O.Store#setRecordForStoreKey

        Sets the record instance for a store key.

        Parameters:
            storeKey - {String} The store key of the record.
            record   - {O.Record} The record.

        Returns:
            {O.Store} Returns self.
    */
    setRecordForStoreKey(storeKey, record) {
        this._skToRecord[storeKey] = record;
        return this;
    },

    /**
        Method: O.Store#materialiseRecord

        Returns the record object for a given store key, creating it if this is
        the first time it has been requested.

        Parameters:
            storeKey - {String} The store key of the record.

        Returns:
            {O.Record} Returns the requested record.
    */
    materialiseRecord(storeKey) {
        return (
            this._skToRecord[storeKey] ||
            (this._skToRecord[storeKey] = new this._skToType[storeKey](
                this,
                storeKey,
            ))
        );
    },

    // ---

    /**
        Method: O.Store#mayUnloadRecord

        Called before unloading a record from memory. Checks the record is in a
        clean state and does not have any observers and that every nested store
        also has no objection to unloading the record.

        Parameters:
            storeKey - {String} The store key of the record.

        Returns:
            {Boolean} True if the store may unload the record.
    */
    mayUnloadRecord(storeKey) {
        const record = this._skToRecord[storeKey];
        const status = this.getStatus(storeKey);
        // Only unload unwatched clean, non-committing records.
        if (
            status & (COMMITTING | NEW | DIRTY) ||
            (record && record.hasObservers())
        ) {
            return false;
        }
        return this._nestedStores.every((store) => {
            return store.mayUnloadRecord(storeKey);
        });
    },

    /**
        Method: O.Store#willUnloadRecord

        Called just before the record is removed from memory. If the record has
        been instantiated it will call <O.Record#storeWillUnload>. The method is
        then recursively called on nested stores.

        Parameters:
            storeKey - {String} The store key of the record being unloaded.

        Returns:
            {O.Store} Returns self.
    */
    willUnloadRecord(storeKey) {
        const record = this._skToRecord[storeKey];
        if (record) {
            record.storeWillUnload();
        }
        this._nestedStores.forEach((store) => {
            store.willUnloadRecord(storeKey);
        });
        return this;
    },

    /**
        Method: O.Store#unloadRecord

        Unloads everything about a record from the store, freeing up memory,
        providing it is safe to do so. Will have no effect if
        <O.Store#mayUnloadRecord> returns false for the given store key.

        Parameters:
            storeKey - {String} The store key of the record to be unloaded.

        Returns:
            {Boolean} Was the record unloaded?
    */
    unloadRecord(storeKey) {
        if (!this.mayUnloadRecord(storeKey)) {
            return false;
        }
        this.willUnloadRecord(storeKey);

        delete this._skToLastAccess[storeKey];
        delete this._skToRecord[storeKey];
        delete this._skToRollback[storeKey];
        delete this._skToData[storeKey];
        delete this._skToStatus[storeKey];

        // Can't delete id/sk mapping without checking if we have any other
        // references to this key elsewhere (as either a foreign key or in a
        // remote query). For now just always keep.

        return true;
    },

    // ---

    /**
        Method: O.Store#createRecord

        Creates a new record with the given store key. The existing status for
        the store key must be <O.Status.EMPTY>. An initial data object may be
        passed as a second argument. The new record will be committed back to
        the server the next time <O.Store#commitChanges> runs.

        You will not normally use this method; instead just create a new record
        using `new ORecordSubclass()` and then call <O.Record#saveToStore>.

        Parameters:
            storeKey - {String} The store key of the new record.
            data     - {Object} (optional) The initial data for the record.

        Returns:
            {O.Store} Returns self.
    */
    createRecord(storeKey, data, _isCopyOfStoreKey) {
        const status = this.getStatus(storeKey);
        if (status !== EMPTY && status !== DESTROYED) {
            didError({
                name: CANNOT_CREATE_EXISTING_RECORD_ERROR,
                message:
                    '\nStatus: ' +
                    (keyOf(Status, status) || status) +
                    '\nData: ' +
                    JSON.stringify(data),
            });
            return this;
        }

        if (!data) {
            data = {};
        }
        data.accountId = this.getAccountIdFromStoreKey(storeKey);

        this._created[storeKey] = _isCopyOfStoreKey || '';
        this._skToData[storeKey] = data;

        this.setStatus(storeKey, READY | NEW | DIRTY);

        if (this.autoCommit) {
            this.commitChanges();
        }

        return this.set('hasChanges', true);
    },

    /**
        Method: O.Store#moveRecord

        Creates a copy of a record with the given store key in a different
        account and destroys the original.

        Parameters:
            storeKey    - {String} The store key of the record to copy
            toAccountId - {String} The id of the account to copy to

        Returns:
            {String} The store key of the copy.
    */
    moveRecord(storeKey, toAccountId, copyStoreKey) {
        const Type = this._skToType[storeKey];
        const copyData = clone(this._skToData[storeKey]);
        copyStoreKey = copyStoreKey || this._created[storeKey];
        if (copyStoreKey) {
            this.undestroyRecord(copyStoreKey, Type, copyData, storeKey);
        } else {
            copyStoreKey = this.getStoreKey(toAccountId, Type);
            this.createRecord(copyStoreKey, copyData, storeKey);
        }
        // Swizzle the storeKey on records
        this._changeRecordStoreKey(storeKey, copyStoreKey);
        // Revert data, because the change is all in the copy now.
        this.revertData(storeKey);
        this.destroyRecord(storeKey, copyStoreKey);
        return copyStoreKey;
    },

    _changeRecordStoreKey(oldStoreKey, newStoreKey) {
        const { _skToRecord } = this;
        const record = _skToRecord[oldStoreKey];
        if (record) {
            delete _skToRecord[oldStoreKey];
            _skToRecord[newStoreKey] = record;
            record
                .set('storeKey', newStoreKey)
                .computedPropertyDidChange('accountId');
        }
        this._nestedStores.forEach((store) => {
            store._changeRecordStoreKey(oldStoreKey, newStoreKey);
        });
    },

    /**
        Method: O.Store#destroyRecord

        Marks a record as destroyed and commits this back to the server when
        O.Store#commitChanges next runs. If the record is new it is immediately
        unloaded from memory, otherwise the store waits until the destroy has
        been committed.

        You will not normally use this method; instead just call
        <O.Record#destroy> on the record object itself.

        Parameters:
            storeKey - {String} The store key of the record to be destroyed.

        Returns:
            {O.Store} Returns self.
    */
    destroyRecord(storeKey, _ifCopiedStoreKey) {
        const status = this.getStatus(storeKey);
        // If created -> just remove from created.
        if (status === (READY | NEW | DIRTY)) {
            delete this._created[storeKey];
            this.setStatus(storeKey, DESTROYED);
            this.unloadRecord(storeKey);
        } else if (status & READY) {
            // Discard changes if dirty.
            if (status & DIRTY) {
                this.setData(storeKey, this._skToCommitted[storeKey]);
                delete this._skToCommitted[storeKey];
                delete this._skToChanged[storeKey];
                if (this.isNested) {
                    delete this._skToData[storeKey];
                }
            }
            this._destroyed[storeKey] = _ifCopiedStoreKey || '';
            // Maintain COMMITTING flag so we know to wait for that to finish
            // before committing the destroy.
            // Maintain NEW flag as we have to wait for commit to finish (so we
            // have an id) before we can destroy it.
            // Maintain OBSOLETE flag in case we have to roll back.
            this.setStatus(
                storeKey,
                DESTROYED | DIRTY | (status & (COMMITTING | NEW | OBSOLETE)),
            );
            if (this.autoCommit) {
                this.commitChanges();
            }
        }
        return mayHaveChanges(this);
    },

    undestroyRecord(storeKey, Type, data, _isCopyOfStoreKey) {
        const status = this.getStatus(storeKey);
        if (data) {
            data = filterObject(data, Record.getClientSettableAttributes(Type));
        }
        if (status === EMPTY || status === DESTROYED) {
            this.createRecord(storeKey, data, _isCopyOfStoreKey);
        } else {
            if ((status & ~(OBSOLETE | LOADING)) === (DESTROYED | COMMITTING)) {
                this.setStatus(storeKey, READY | NEW | COMMITTING);
                this._created[storeKey] = _isCopyOfStoreKey || '';
            } else if (status & DESTROYED) {
                this.setStatus(
                    storeKey,
                    (status & ~(DESTROYED | DIRTY)) | READY,
                );
                delete this._destroyed[storeKey];
            }
            if (data) {
                this.updateData(storeKey, data, true);
            }
        }
        return mayHaveChanges(this);
    },

    // ---

    /**
        Method: O.Store#checkServerState

        Called internally when a type finishes loading or committing, to check
        if there's a server state update to process.

        Parameters:
            accountId - {String|null} The account id.
            Type      - {O.Class} The record type.
    */
    checkServerState(accountId, Type) {
        if (!accountId) {
            accountId = this.getPrimaryAccountIdForType(Type);
        }
        const typeToServerState = this._accounts[accountId].serverState;
        const typeId = guid(Type);
        const serverState = typeToServerState[typeId];
        if (serverState) {
            typeToServerState[typeId] = '';
            this.sourceStateDidChange(accountId, Type, serverState);
        }
    },

    /**
        Method: O.Store#fetchAll

        Fetches all records of a given type from the server, or if already
        fetched updates the set of records.

        Parameters:
            accountId - {String|null} (optional) The account id. Omit to fetch
                        for all accounts.
            Type  - {O.Class} The type of records to fetch.
            force - {Boolean} (optional) Fetch even if we have a state string.

        Returns:
            {O.Store} Returns self.
    */
    fetchAll(accountId, Type, force) {
        // If accountId omitted => fetch all
        if (typeof accountId === 'function') {
            force = Type;
            Type = accountId;

            const _accounts = this._accounts;
            for (accountId in _accounts) {
                if (
                    accountId &&
                    Type.dataGroup in _accounts[accountId].accountCapabilities
                ) {
                    this.fetchAll(accountId, Type, force);
                }
            }
            return this;
        }

        if (!accountId) {
            accountId = this.getPrimaryAccountIdForType(Type);
        }
        const account = this._accounts[accountId];
        const typeId = guid(Type);
        const typeToStatus = account.status;
        const status = typeToStatus[typeId];
        const state = account.clientState[typeId];

        if (!(status & LOADING) && (!(status & READY) || force)) {
            this.source.fetchAllRecords(accountId, Type, state, () => {
                typeToStatus[typeId] &= ~LOADING;
                this.checkServerState(accountId, Type);
            });
            typeToStatus[typeId] |= LOADING;
        }
        return this;
    },

    // ---

    /**
        Method: O.Store#fetchData

        Fetches the data for a given record from the server.

        Parameters:
            storeKey - {String} The store key of the record to fetch.

        Returns:
            {O.Store} Returns self.
    */
    fetchData(storeKey) {
        const status = this.getStatus(storeKey);
        // Nothing to do if already loading or new, destroyed or non-existent.
        if (status & (LOADING | NEW | DESTROYED | NON_EXISTENT)) {
            return this;
        }
        const Type = this._skToType[storeKey];
        if (!Type) {
            return this;
        }
        const typeId = guid(Type);
        const id = this._typeToSKToId[typeId][storeKey];
        if (!id) {
            return this;
        }
        const accountId = this.getAccountIdFromStoreKey(storeKey);

        let callback;
        if (id === 'singleton') {
            const typeToStatus = this._accounts[accountId].status;
            typeToStatus[typeId] |= LOADING;
            callback = () => {
                typeToStatus[typeId] &= ~LOADING;
                this.checkServerState(accountId, Type);
            };
        }

        if (status & EMPTY) {
            this.source.fetchRecord(accountId, Type, id, callback);
            this.setStatus(storeKey, EMPTY | LOADING);
        } else {
            this.source.refreshRecord(accountId, Type, id, callback);
            this.setStatus(storeKey, status | LOADING);
        }
        return this;
    },

    /**
        Method: O.Store#getData

        Returns the current data object in memory for the given record

        Parameters:
            storeKey - {String} The store key for the record.

        Returns:
            {Object|undefined} The record data, if loaded.
    */
    getData(storeKey) {
        return this._skToData[storeKey];
    },

    /**
        Method: O.Store#setData

        Sets the data object for a given record.

        Parameters:
            storeKey      - {String} The store key for the record.
            data          - {Object} The new data object for the record.

        Returns:
            {O.Store} Returns self.
    */
    setData(storeKey, data) {
        if (this.getStatus(storeKey) & READY) {
            this.updateData(storeKey, data, false);
        } else {
            const changedKeys = Object.keys(data);
            this._skToData[storeKey] = data;
            this._notifyRecordOfChanges(storeKey, changedKeys);
            this._nestedStores.forEach((store) => {
                store.parentDidSetData(storeKey, changedKeys);
            });
        }
        return this;
    },

    /**
        Method: O.Store#updateData

        Updates the data object for a given record with the supplied attributes.

        Parameters:
            storeKey      - {String} The store key for the record.
            data          - {Object} An object of new attribute values for the
                            record.
            changeIsDirty - {Boolean} Should any of the change be committed back
                            to the server? noSync attributes are filtered out of
                            commits to the server in the commitChanges method.

        Returns:
            {Boolean} Was the data actually written? Will be false if the
            changeIsDirty flag is set but the current data is not yet loaded
            into memory.
    */
    updateData(storeKey, data, changeIsDirty) {
        const status = this.getStatus(storeKey);
        const { _skToData, _skToCommitted, _skToChanged, isNested } = this;
        let current = _skToData[storeKey];
        const changedKeys = [];
        let seenChange = false;

        if (!current || (changeIsDirty && !(status & READY))) {
            didError({
                name: CANNOT_WRITE_TO_UNREADY_RECORD_ERROR,
                message:
                    '\nStatus: ' +
                    (keyOf(Status, status) || status) +
                    '\nData: ' +
                    JSON.stringify(data),
            });
            return false;
        }

        // Copy-on-write for nested stores.
        if (isNested && !_skToData.hasOwnProperty(storeKey)) {
            _skToData[storeKey] = current = clone(current);
        }

        if (changeIsDirty && status !== (READY | NEW | DIRTY)) {
            const committed =
                _skToCommitted[storeKey] ||
                (_skToCommitted[storeKey] = clone(current));
            const changed =
                _skToChanged[storeKey] || (_skToChanged[storeKey] = {});

            for (const key in data) {
                const value = data[key];
                const oldValue = current[key];
                if (!isEqual(value, oldValue)) {
                    current[key] = value;
                    changedKeys.push(key);
                    changed[key] = !isEqual(value, committed[key]);
                    seenChange = seenChange || changed[key];
                }
            }
            // If we just reset properties to their committed values, we should
            // check to see if there are any changes remaining.
            if (!seenChange) {
                for (const key in changed) {
                    if (changed[key]) {
                        seenChange = true;
                        break;
                    }
                }
            }
            // If there are still changes remaining, set the DIRTY flag and
            // commit. Otherwise, remove the DIRTY flag and reset state.
            if (seenChange) {
                this.setStatus(storeKey, status | DIRTY);
                if (this.autoCommit) {
                    this.commitChanges();
                }
            } else {
                this.setStatus(storeKey, status & ~DIRTY);
                delete _skToCommitted[storeKey];
                delete _skToChanged[storeKey];
                if (isNested) {
                    delete _skToData[storeKey];
                }
            }
            mayHaveChanges(this);
        } else {
            for (const key in data) {
                const value = data[key];
                const oldValue = current[key];
                if (!isEqual(value, oldValue)) {
                    current[key] = value;
                    changedKeys.push(key);
                }
            }
        }

        // If the record is new (so not in other stores), update the accountId
        // associated with the record.
        const accountId = data.accountId;
        if (status === (READY | NEW | DIRTY) && accountId) {
            this._skToAccountId[storeKey] = accountId;
        }

        this._notifyRecordOfChanges(storeKey, changedKeys);
        this._nestedStores.forEach((store) => {
            store.parentDidUpdateData(storeKey, changedKeys);
        });
        this._recordDidChange(storeKey);
        return true;
    },

    /**
        Method: O.Store#revertData

        Reverts the data object for a given record to the last committed state.

        Parameters:
            storeKey - {String} The store key for the record.

        Returns:
            {O.Store} Returns self.
    */
    revertData(storeKey) {
        const Type = this._skToType[storeKey];
        const committed = this._skToCommitted[storeKey];
        const changed = this._skToChanged[storeKey];

        if (committed) {
            const proto = Type.prototype;
            const attrs = meta(proto).attrs;
            let defaultValue;
            for (const attrKey in changed) {
                if (committed[attrKey] === undefined) {
                    defaultValue = proto[attrs[attrKey]].defaultValue;
                    if (defaultValue === undefined) {
                        defaultValue = null;
                    }
                    committed[attrKey] = defaultValue;
                }
            }
            this.updateData(storeKey, committed, true);
        }

        return this;
    },

    /**
        Method (private): O.Store#_notifyRecordOfChanges

        Triggers change notifications if this record has an instantiated
        instance, and informs nested stores so they can do likewise.

        Parameters:
            storeKey    - {String} The store key of the record with changes.
            changedKeys - {Array} A list of the properties which have changed.

        Returns:
            {O.Store} Returns self.
    */
    _notifyRecordOfChanges(storeKey, changedKeys) {
        const record = this._skToRecord[storeKey];
        if (record) {
            let errorForAttribute;
            const attrs = meta(record).attrs;
            record.beginPropertyChanges();
            for (let i = changedKeys.length - 1; i >= 0; i -= 1) {
                const attrKey = changedKeys[i];
                let propKey = attrs[attrKey];
                // Server may return more data than is defined in the record;
                // ignore the rest.
                if (!propKey) {
                    // Special case: implicit id/accountId attributes
                    if (attrKey === 'id' || attrKey === 'accountId') {
                        propKey = attrKey;
                    } else {
                        continue;
                    }
                }
                const attribute = record[propKey];
                record.computedPropertyDidChange(propKey);
                if (attribute.validate) {
                    if (!errorForAttribute) {
                        errorForAttribute = record.get('errorForAttribute');
                    }
                    errorForAttribute.set(
                        propKey,
                        attribute.validate(
                            record.get(propKey),
                            propKey,
                            record,
                        ),
                    );
                }
            }
            record.endPropertyChanges();
        }
        return this;
    },

    /**
        Method: O.Store#_recordDidChange

        Called when the status and/or data for a record changes.

        Parameters:
            storeKey - {String} The store key of the record.
    */
    _recordDidChange(storeKey) {
        const typeId = guid(this._skToType[storeKey]);
        this._changedTypes[typeId] = true;
        queueFn('middle', this._fireTypeChanges, this);
    },

    /**
        Method: O.Store#_fireTypeChanges
    */
    _fireTypeChanges() {
        const { _changedTypes } = this;
        this._changedTypes = {};

        for (const typeId in _changedTypes) {
            this.fire(typeId);
        }

        return this;
    },

    // === Queries =============================================================

    /**
        Method: O.Store#findAll

        Returns the list of store keys with data loaded for a particular type,
        optionally filtered and/or sorted.

        Parameters:
            Type   - {O.Class} The constructor for the record type being
                     queried.
            filter - {Function} (optional) An acceptance function. This will be
                     passed the raw data object (*not* a record instance) and
                     should return true if the record should be included, or
                     false otherwise.
            sort   - {Function} (optional) A comparator function. This will be
                     passed the raw data objects (*not* record instances) for
                     two records. It should return -1 if the first record should
                     come before the second, 1 if the inverse is true, or 0 if
                     they should have the same position.

        Returns:
            {String[]} An array of store keys.
    */
    findAll(Type, accept, compare) {
        const skToId = this._typeToSKToId[guid(Type)] || {};
        const { _skToStatus } = this;
        let results = [];

        for (const storeKey in skToId) {
            if (_skToStatus[storeKey] & READY) {
                results.push(storeKey);
            }
        }

        if (accept) {
            const filterFn = acceptStoreKey.bind(this, accept);
            results = results.filter(filterFn);
            results.filterFn = filterFn;
        }

        if (compare) {
            const sortFn = compareStoreKeys.bind(this, compare);
            results.sort(sortFn);
            results.sortFn = sortFn;
        }

        return results;
    },

    /**
        Method: O.Store#findOne

        Returns the store key of the first loaded record that matches an
        acceptance function.

        Parameters:
            Type   - {O.Class} The constructor for the record type to find.
            filter - {Function} (optional) An acceptance function. This will be
                     passed the raw data object (*not* a record instance) and
                     should return true if the record is the desired one, or
                     false otherwise.

        Returns:
            {(String|null)} The store key for a matching record, or null if none
            found.
    */
    findOne(Type, accept) {
        const _skToId = this._typeToSKToId[guid(Type)] || {};
        const { _skToStatus } = this;
        const filterFn = accept && acceptStoreKey.bind(this, accept);

        for (const storeKey in _skToId) {
            if (
                _skToStatus[storeKey] & READY &&
                (!filterFn || filterFn(storeKey))
            ) {
                return storeKey;
            }
        }

        return null;
    },

    /**
        Method: O.Store#addQuery

        Registers a query with the store. This is automatically called by the
        query constructor function. You should never need to call this
        manually.

        Parameters:
            query - {O.Query} The query object.

        Returns:
            {O.Store} Returns self.
    */
    addQuery(query) {
        this._idToQuery[query.get('id')] = query;
        return this;
    },

    /**
        Method: O.Store#removeQuery

        Deregisters a query with the store. This is automatically called when
        you call destroy() on a query. You should never need to call this
        manually.

        Parameters:
            query - {O.Query} The query object.

        Returns:
            {O.Store} Returns self.
    */
    removeQuery(query) {
        delete this._idToQuery[query.get('id')];
        return this;
    },

    /**
        Method: O.Store#getQuery

        Get a named query. When the same query is used in different places in
        the code, use this method to get the query rather than directly calling
        new Query(...). If the query is already created it will be returned,
        otherwise it will be created and returned. If no QueryClass is supplied
        and the id does not correspond to an existing query then `null` will be
        returned.

        Parameters:
            id         - {String} The id of the requested query.
            QueryClass - {O.Class} (optional) The query class to use if the
                         query is not already created.
            mixin      - {(Object|null)} (optional) Properties to pass to the
                         QueryClass constructor.

        Returns:
            {(O.Query|null)} The requested query.
    */
    getQuery(id, QueryClass, mixin) {
        let query = (id && this._idToQuery[id]) || null;
        if (!query && QueryClass) {
            query = new QueryClass(
                Object.assign(mixin || {}, {
                    id,
                    store: this,
                    source: this.get('source'),
                }),
            );
        }
        if (query) {
            query.lastAccess = Date.now();
        }
        return query;
    },

    /**
        Method: O.Store#getAllQueries

        Returns a list of all remote queries registered with the store.

        Returns:
            {O.Query[]} A list of all registered queries.
    */
    getAllQueries() {
        return Object.values(this._idToQuery);
    },

    // === Source callbacks ====================================================

    /**
        Method: O.Store#sourceStateDidChange

        Call this method to notify the store of a change in the state of a
        particular record type in the source. The store will wait for any
        loading or committing of this type to finish, then check its state. If
        it doesn't match, it will then request updates.

        Parameters:
            accountId - {String|null} The account id.
            Type      - {O.Class} The record type.
            newState  - {String} The new state on the server.

        Returns:
            {O.Store} Returns self.
    */
    sourceStateDidChange(accountId, Type, newState) {
        const account = this.getAccount(accountId, Type);
        const typeId = guid(Type);
        const clientState = account.clientState[typeId];
        const oldState = account.serverState[typeId];

        if (oldState !== newState) {
            // if !oldState => we're checking if a pushed state still needs
            // fetching. Due to concurrency, if this doesn't match newState,
            // we don't know if it's older or newer. As we're now requesting
            // updates, we can reset it to be clientState and then it will be
            // updated to the real new server automatically if has changed in
            // the sourceDidFetchUpdates handler. If a push comes in while
            // fetching the updates, this won't match and we'll fetch again.
            account.serverState[typeId] =
                oldState || !clientState ? newState : clientState;
            if (
                newState !== clientState &&
                !account.ignoreServerState &&
                !(account.status[typeId] & (LOADING | COMMITTING))
            ) {
                if (clientState) {
                    this.fetchAll(accountId, Type, true);
                }
                // We have a query but not matches yet; we still need to
                // refresh the queries in case there are now matches.
                this.fire(typeId + ':server:' + accountId);
            }
        }

        return this;
    },

    // ---

    /**
        Method: O.Store#sourceDidFetchRecords

        Callback made by the <O.Source> object associated with this store when
        it fetches some records from the server.

        Parameters:
            accountId - {String} The account id.
            Type      - {O.Class} The record type.
            records   - {Object[]} Array of data objects.
            state     - {String} (optional) The state of the record type on the
                        server.
            isAll     - {Boolean} This is all the records of this type on the
                        server.

        Returns:
            {O.Store} Returns self.
    */
    sourceDidFetchRecords(accountId, Type, records, state, isAll) {
        const { _skToData, _skToLastAccess } = this;
        if (!accountId) {
            accountId = this.getPrimaryAccountIdForType(Type);
        }
        const account = this._accounts[accountId];
        const typeId = guid(Type);
        const idPropKey = Type.primaryKey || 'id';
        const idAttrKey = Type.prototype[idPropKey].key || idPropKey;
        const now = Date.now();
        const seen = {};
        const updates = {};
        const foreignRefAttrs = getForeignRefAttrs(Type);

        for (let i = records.length - 1; i >= 0; i -= 1) {
            const data = records[i];
            const id = data[idAttrKey];
            const storeKey = this.getStoreKey(accountId, Type, id);
            const status = this.getStatus(storeKey);
            seen[storeKey] = true;

            if (foreignRefAttrs.length) {
                convertForeignKeysToSK(this, foreignRefAttrs, data, accountId);
            }
            data.accountId = accountId;

            if (status & READY) {
                // We already have the record loaded, process it as an update.
                updates[id] = data;
            } else if (status & DESTROYED && status & (DIRTY | COMMITTING)) {
                // We're in the middle of destroying it. Update the data in case
                // we need to roll back.
                _skToData[storeKey] = data;
                this.setStatus(storeKey, status & ~LOADING);
            } else {
                // Anything else is new.
                if (!(status & EMPTY)) {
                    // Record was destroyed or non-existent, but has now been
                    // created (again). Set status back to empty so setData
                    // works.
                    this.setStatus(storeKey, EMPTY);
                }
                this.setData(storeKey, data);
                this.setStatus(storeKey, READY);
                _skToLastAccess[storeKey] = now;
            }
        }

        if (isAll) {
            const skToId = this._typeToSKToId[guid(Type)];
            const destroyed = [];
            for (const storeKey in skToId) {
                if (seen[storeKey]) {
                    continue;
                }
                const status = this.getStatus(storeKey);
                if (
                    status & READY &&
                    !(status & NEW) &&
                    _skToData[storeKey].accountId === accountId
                ) {
                    destroyed.push(skToId[storeKey]);
                }
            }
            if (destroyed.length) {
                this.sourceDidDestroyRecords(accountId, Type, destroyed);
            }
        }

        this.sourceDidFetchPartialRecords(accountId, Type, updates, true);

        if (state) {
            const oldClientState = account.clientState[typeId];
            const oldServerState = account.serverState[typeId];
            // If the state has changed, we need to fetch updates, but we can
            // still load these records
            if (!isAll && oldClientState && oldClientState !== state) {
                this.sourceStateDidChange(accountId, Type, state);
            } else {
                account.clientState[typeId] = state;
                if (
                    !oldClientState ||
                    !oldServerState ||
                    // If oldClientState == oldServerState, then the state we've
                    // just received MUST be newer so we can update the server
                    // state too
                    oldClientState === oldServerState
                ) {
                    account.serverState[typeId] = state;
                }
            }
        }
        account.status[typeId] |= READY;

        const resolve = account.awaitingReadyResolve[typeId];
        if (resolve) {
            resolve();
            delete account.awaitingReadyResolve[typeId];
            delete account.awaitingReadyPromise[typeId];
        }

        // Notify LocalQuery we're now ready even if no records loaded.
        this._changedTypes[typeId] = true;
        queueFn('middle', this._fireTypeChanges, this);

        return this;
    },

    /**
        Method: O.Store#sourceDidFetchPartialRecords

        Callback made by the <O.Source> object associated with this store when
        it has fetched some updates to records which may be loaded in the store.
        An update is a subset of a normal data object for the given record type,
        containing only the attributes which have changed since the previous
        state.

        Parameters:
            accountId - {String} The account id.
            Type      - {O.Class} The record type.
            updates   - {Object} An object mapping record id to an object of
                        changed attributes.

        Returns:
            {O.Store} Returns self.
    */
    sourceDidFetchPartialRecords(accountId, Type, updates, _idsAreSKs) {
        const account = this.getAccount(accountId, Type);
        const typeId = guid(Type);
        const { _skToData, _skToStatus, _skToChanged, _skToCommitted } = this;
        const _idToSk = account.typeToIdToSK[typeId] || {};
        const _skToId = this._typeToSKToId[typeId] || {};
        const idPropKey = Type.primaryKey || 'id';
        const idAttrKey = Type.prototype[idPropKey].key || idPropKey;
        const foreignRefAttrs = _idsAreSKs ? [] : getForeignRefAttrs(Type);

        for (const id in updates) {
            const storeKey = _idToSk[id];
            const status = _skToStatus[storeKey];
            let update = updates[id];

            // Skip if no update to process
            // Also can't update an empty or destroyed record.
            if (!update || !(status & READY)) {
                continue;
            }

            // If the record is committing, we don't know for sure what state
            // the update was applied on top of, so fetch again to be sure.
            if (status & COMMITTING) {
                this.setStatus(storeKey, status & ~LOADING);
                this.fetchData(storeKey);
                continue;
            }

            if (foreignRefAttrs.length) {
                convertForeignKeysToSK(
                    this,
                    foreignRefAttrs,
                    update,
                    accountId,
                );
            }

            const newId = update[idAttrKey];
            if (newId && newId !== id) {
                // Don't delete the old idToSk mapping, as references to the
                // old id may still appear in queryChanges responses
                _skToId[storeKey] = newId;
                _idToSk[newId] = storeKey;
            }

            if (status & DIRTY) {
                // If we have a conflict we can either rebase on top, or discard
                // our local changes.
                update = Object.assign(_skToCommitted[storeKey], update);
                if (this.rebaseConflicts) {
                    const oldData = _skToData[storeKey];
                    const oldChanged = _skToChanged[storeKey];
                    const newData = {};
                    const newChanged = {};
                    let clean = true;
                    // Every key in here must be reapplied on top, even if
                    // changed[key] === false, as this means it's been
                    // changed then changed back.
                    for (const key in oldData) {
                        if (key in oldChanged) {
                            if (!isEqual(oldData[key], update[key])) {
                                newChanged[key] = true;
                                clean = false;
                            }
                            newData[key] = oldData[key];
                        } else {
                            newData[key] = update[key];
                        }
                    }
                    if (!clean) {
                        _skToChanged[storeKey] = newChanged;
                        _skToCommitted[storeKey] = update;
                        this.setData(storeKey, newData);
                        this.setStatus(storeKey, READY | DIRTY);
                        continue;
                    }
                }
                delete _skToChanged[storeKey];
                delete _skToCommitted[storeKey];
            }

            this.updateData(storeKey, update, false);
            this.setStatus(storeKey, READY);
        }
        return mayHaveChanges(this);
    },

    /**
        Method: O.Store#sourceCouldNotFindRecords

        Callback made by the <O.Source> object associated with this store when
        it has been asked to fetch certain record ids and the server has
        responded that the records do not exist.

        Parameters:
            accountId - {String} The account id.
            Type      - {O.Class} The record type.
            ids       - {String[]} The list of ids of non-existent requested
                        records.

        Returns:
            {O.Store} Returns self.
    */
    sourceCouldNotFindRecords(accountId, Type, ids) {
        const { _skToCommitted, _skToChanged } = this;

        for (let i = ids.length - 1; i >= 0; i -= 1) {
            const storeKey = this.getStoreKey(accountId, Type, ids[i]);
            const status = this.getStatus(storeKey);
            if (status & (EMPTY | NON_EXISTENT)) {
                this.setStatus(storeKey, NON_EXISTENT);
            } else {
                if (status & DIRTY) {
                    this.setData(storeKey, _skToCommitted[storeKey]);
                    delete _skToCommitted[storeKey];
                    delete _skToChanged[storeKey];
                }
                this.setStatus(storeKey, DESTROYED);
                this.unloadRecord(storeKey);
            }
        }
        return mayHaveChanges(this);
    },

    // ---

    /**
        Method: O.Store#sourceDidFetchUpdates

        Callback made by the <O.Source> object associated with this store when
        it fetches the ids of all records of a particular type that have been
        created/modified/destroyed of a particular since the client's state.

        Parameters:
            accountId - {String} The account id.
            Type      - {O.Class} The record type.
            changed   - {String[]} List of ids for records which have been
                        added or changed in the store since oldState.
            destroyed - {String[]} List of ids for records which have been
                        destroyed in the store since oldState.
            oldState  - {String} The state these changes are from.
            newState  - {String} The state these changes are to.

        Returns:
            {O.Store} Returns self.
    */
    sourceDidFetchUpdates(
        accountId,
        Type,
        changed,
        destroyed,
        oldState,
        newState,
    ) {
        const account = this.getAccount(accountId, Type);
        const typeId = guid(Type);
        if (oldState === account.clientState[typeId]) {
            // Invalidate changed records
            if (changed && changed.length) {
                this.sourceDidModifyRecords(accountId, Type, changed);
            }
            if (destroyed && destroyed.length) {
                this.sourceDidDestroyRecords(accountId, Type, destroyed);
            }
            // Invalidate remote queries on the type, unless this was done
            // before.
            if (
                oldState !== newState &&
                newState !== account.serverState[typeId]
            ) {
                this.fire(typeId + ':server:' + accountId);
            }
            account.clientState[typeId] = newState;
            if (account.serverState[typeId] === oldState) {
                account.serverState[typeId] = newState;
            }
        } else {
            this.sourceStateDidChange(accountId, Type, newState);
        }
        return this;
    },

    /**
        Method: O.Store#sourceDidModifyRecords

        Callback made by the <O.Source> object associated with this store when
        some records may be out of date.

        Parameters:
            accountId - {String} The account id.
            Type      - {O.Class} The record type.
            ids       - {String[]} The list of ids of records which have
                        updates available on the server.

        Returns:
            {O.Store} Returns self.
    */
    sourceDidModifyRecords(accountId, Type, ids) {
        for (let i = ids.length - 1; i >= 0; i -= 1) {
            const storeKey = this.getStoreKey(accountId, Type, ids[i]);
            const status = this.getStatus(storeKey);
            if (status & READY) {
                this.setStatus(storeKey, status | OBSOLETE);
            }
        }
        return this;
    },

    /**
        Method: O.Store#sourceDidDestroyRecords

        Callback made by the <O.Source> object associated with this store when
        the source has destroyed records (not in response to a commit request
        by the client).

        Parameters:
            accountId - {String} The account id.
            Type      - {O.Class} The record type.
            ids       - {String[]} The list of ids of records which have been
                        destroyed.

        Returns:
            {O.Store} Returns self.
    */
    sourceDidDestroyRecords(accountId, Type, ids) {
        for (let i = ids.length - 1; i >= 0; i -= 1) {
            const id = ids[i];
            const storeKey = this.getStoreKey(accountId, Type, id);
            // If we have an immutable record, an "update" may have actually
            // been a destroy and create. We may have updated the old record,
            // but the previous id => sk mapping stays to allow query changes
            // to work. So we need to check the reverse mapping gives the
            // original id before updating the store with the destroy.
            if (this.getIdFromStoreKey(storeKey) === id) {
                this.setStatus(storeKey, DESTROYED);
                this.unloadRecord(storeKey);
            }
        }
        return this;
    },

    // ---

    /**
        Method: O.Store#sourceCommitDidChangeState

        Callback made by the <O.Source> object associated with this store when
        it finishes committing a record type which uses state tokens to stay in
        sync with the server.

        Parameters:
            accountId - {String} The account id.
            Type      - {O.Class} The record type.
            oldState  - {String} The state before the commit.
            newState  - {String} The state after the commit.

        Returns:
            {O.Store} Returns self.
    */
    sourceCommitDidChangeState(accountId, Type, oldState, newState) {
        const account = this.getAccount(accountId, Type);
        const typeId = guid(Type);

        if (account.clientState[typeId] === oldState) {
            account.clientState[typeId] = newState;
            if (account.serverState[typeId] === oldState) {
                account.serverState[typeId] = newState;
            }
        } else {
            this.sourceStateDidChange(accountId, Type, newState);
        }

        return this;
    },

    // ---

    /**
        Method: O.Store#sourceDidCommitCreate

        Callback made by the <O.Source> object associated with this store when
        the source commits the creation of records as requested by a call to
        <O.Source#commitChanges>.

        Parameters:
            skToPartialData - {Object} A map of the store key to an object
            with properties for the newly created record, which MUST include
            the id.

        Returns:
            {O.Store} Returns self.
    */
    sourceDidCommitCreate(skToPartialData) {
        const { _skToType, _skToData, _typeToSKToId, _accounts } = this;
        for (const storeKey in skToPartialData) {
            const status = this.getStatus(storeKey);
            if (status & NEW) {
                const data = skToPartialData[storeKey];

                const Type = _skToType[storeKey];
                const typeId = guid(Type);
                const idPropKey = Type.primaryKey || 'id';
                const idAttrKey = Type.prototype[idPropKey].key || idPropKey;
                const accountId = _skToData[storeKey].accountId;
                const id = data[idAttrKey];
                const typeToIdToSK = _accounts[accountId].typeToIdToSK;
                const skToId =
                    _typeToSKToId[typeId] || (_typeToSKToId[typeId] = {});
                const idToSK =
                    typeToIdToSK[typeId] || (typeToIdToSK[typeId] = {});

                // Set id internally
                skToId[storeKey] = id;
                idToSK[id] = storeKey;

                const foreignRefAttrs = getForeignRefAttrs(Type);
                if (foreignRefAttrs.length) {
                    convertForeignKeysToSK(
                        this,
                        foreignRefAttrs,
                        data,
                        accountId,
                    );
                }

                // Notify record, and update with any other data
                this.updateData(storeKey, data, false);
                this.setStatus(storeKey, status & ~(COMMITTING | NEW));
            } else {
                didError({
                    name: SOURCE_COMMIT_CREATE_MISMATCH_ERROR,
                });
            }
        }
        if (this.autoCommit) {
            this.commitChanges();
        }
        return this;
    },

    /**
        Method: O.Store#sourceDidNotCreate

        Callback made by the <O.Source> object associated with this store when
        the source does not commit the creation of some records as requested
        by a call to <O.Source#commitChanges>.

        If the condition is temporary (for example a precondition fail, such as
        the server being in a different state to the client) then the store
        will attempt to recommit the changes the next time commitChanges is
        called (or at the end of the current run loop if `autoCommit` is
        `true`); it is presumed that the precondition will be fixed before then.

        If the condition is permanent (as indicated by the `isPermanent`
        argument), the store will revert to the last known committed state,
        i.e. it will destroy the new record. If an `errors` array is passed,
        the store will first fire a `record:commit:error` event on the
        record (including in nested stores), if already instantiated. If
        <O.Event#preventDefault> is called on the event object, the record
        will **not** be reverted; it is up to the handler to then fix the record
        before it is recommitted.

        Parameters:
            storeKeys   - {String[]} The list of store keys of records for
                          which the creation was not committed.
            isPermanent - {Boolean} (optional) Should the store try to commit
                          the changes again, or just revert to last known
                          committed state?
            errors      - {Object[]} (optional) An array of objects
                          representing the error in committing the store key in
                          the equivalent location in the *storeKeys* argument.

        Returns:
            {O.Store} Returns self.
    */
    sourceDidNotCreate(storeKeys, isPermanent, errors) {
        const { _skToCommitted, _skToChanged, _created } = this;

        for (let i = storeKeys.length - 1; i >= 0; i -= 1) {
            const storeKey = storeKeys[i];
            const status = this.getStatus(storeKey);
            if (status & DESTROYED) {
                this.setStatus(storeKey, DESTROYED);
                this.unloadRecord(storeKey);
            } else {
                if (status & DIRTY) {
                    delete _skToCommitted[storeKey];
                    delete _skToChanged[storeKey];
                }
                this.setStatus(storeKey, READY | NEW | DIRTY);
                _created[storeKey] = '';
                if (
                    isPermanent &&
                    (!errors || !this._notifyRecordOfError(storeKey, errors[i]))
                ) {
                    this.destroyRecord(storeKey);
                }
            }
        }
        if (this.autoCommit) {
            this.commitChanges();
        }
        return mayHaveChanges(this);
    },

    /**
        Method: O.Store#sourceDidCommitUpdate

        Callback made by the <O.Source> object associated with this store when
        the source commits updates to some records as requested by a call to
        <O.Source#commitChanges>.

        Parameters:
            storeKeys - {String[]} The list of store keys of records for
                        which the submitted updates have been committed.

        Returns:
            {O.Store} Returns self.
    */
    sourceDidCommitUpdate(storeKeys) {
        const { _skToRollback } = this;

        for (let i = storeKeys.length - 1; i >= 0; i -= 1) {
            const storeKey = storeKeys[i];
            const status = this.getStatus(storeKey);
            delete _skToRollback[storeKey];
            if (status !== EMPTY) {
                this.setStatus(storeKey, status & ~COMMITTING);
            }
        }
        if (this.autoCommit) {
            this.commitChanges();
        }
        return this;
    },

    /**
        Method: O.Store#sourceDidNotUpdate

        Callback made by the <O.Source> object associated with this store when
        the source does not commit the updates to some records as requested
        by a call to <O.Source#commitChanges>.

        If the condition is temporary (for example a precondition fail, such as
        the server being in a different state to the client) then the store
        will attempt to recommit the changes the next time commitChanges is
        called (or at the end of the current run loop if `autoCommit` is
        `true`); it is presumed that the precondition will be fixed before then.

        If the condition is permanent (as indicated by the `isPermanent`
        argument), the store will revert to the last known committed state.
        If an `errors` array is passed, the store will first fire a
        `record:commit:error` event on the record (including in nested stores),
        if already instantiated. If <O.Event#preventDefault> is called on the
        event object, the record will **not** be reverted; it is up to the
        handler to then fix the record before it is recommitted.

        Parameters:
            storeKeys   - {String[]} The list of store keys of records for
                          which the update was not committed.
            isPermanent - {Boolean} (optional) Should the store try to commit
                          the changes again, or just revert to last known
                          committed state?
            errors      - {Object[]} (optional) An array of objects
                          representing the error in committing the store key in
                          the equivalent location in the *storeKeys* argument.

        Returns:
            {O.Store} Returns self.
    */
    sourceDidNotUpdate(storeKeys, isPermanent, errors) {
        const {
            _skToData,
            _skToChanged,
            _skToCommitted,
            _skToRollback,
            _skToType,
        } = this;

        for (let i = storeKeys.length - 1; i >= 0; i -= 1) {
            const storeKey = storeKeys[i];
            const status = this.getStatus(storeKey);
            // If destroyed now, but still in memory, revert the data so
            // that if the destroy fails we still have the right data.
            if (status & DESTROYED && _skToRollback[storeKey]) {
                _skToData[storeKey] = _skToRollback[storeKey];
                delete _skToRollback[storeKey];
            }
            // Other than that, we don't care about unready records
            if (!(status & READY)) {
                // But make sure we know it's no longer committing.
                if (status !== EMPTY) {
                    this.setStatus(storeKey, status & ~COMMITTING);
                }
                continue;
            }
            const committed = (_skToCommitted[storeKey] =
                _skToRollback[storeKey]);
            delete _skToRollback[storeKey];
            const current = _skToData[storeKey];
            delete _skToChanged[storeKey];
            const changed = getChanged(_skToType[storeKey], current, committed);
            if (changed) {
                _skToChanged[storeKey] = changed;
                this.setStatus(storeKey, (status & ~COMMITTING) | DIRTY);
            } else {
                this.setStatus(storeKey, status & ~COMMITTING);
            }
            if (
                isPermanent &&
                (!errors || !this._notifyRecordOfError(storeKey, errors[i]))
            ) {
                this.revertData(storeKey);
            }
        }
        if (this.autoCommit) {
            this.commitChanges();
        }
        return mayHaveChanges(this);
    },

    /**
        Method: O.Store#sourceDidCommitDestroy

        Callback made by the <O.Source> object associated with this store when
        the source commits the destruction of some records as requested by a
        call to <O.Source#commitChanges>.

        Parameters:
            storeKeys - {String[]} The list of store keys of records whose
                        destruction has been committed.

        Returns:
            {O.Store} Returns self.
    */
    sourceDidCommitDestroy(storeKeys) {
        for (let i = storeKeys.length - 1; i >= 0; i -= 1) {
            const storeKey = storeKeys[i];
            const status = this.getStatus(storeKey);

            // If the record has been undestroyed while being committed
            // it will no longer be in the destroyed state, but instead be
            // READY|NEW|COMMITTING.
            if ((status & ~DIRTY) === (READY | NEW | COMMITTING)) {
                if (status & DIRTY) {
                    delete this._skToCommitted[storeKey];
                    delete this._skToChanged[storeKey];
                }
                this.setStatus(storeKey, READY | NEW | DIRTY);
            } else if (status & DESTROYED) {
                this.setStatus(storeKey, DESTROYED);
                this.unloadRecord(storeKey);
            } else {
                didError({
                    name: SOURCE_COMMIT_DESTROY_MISMATCH_ERROR,
                });
            }
        }
        if (this.autoCommit) {
            this.commitChanges();
        }
        return mayHaveChanges(this);
    },

    /**
        Method: O.Store#sourceDidNotDestroy

        Callback made by the <O.Source> object associated with this store when
        the source does not commit the destruction of some records as requested
        by a call to <O.Source#commitChanges> (usually due to a precondition
        fail, such as the server being in a different state to the client).

        If the condition is temporary (for example a precondition fail, such as
        the server being in a different state to the client) then the store
        will attempt to recommit the changes the next time commitChanges is
        called (or at the end of the current run loop if `autoCommit` is
        `true`); it is presumed that the precondition will be fixed before then.

        If the condition is permanent (as indicated by the `isPermanent`
        argument), the store will revert to the last known committed state
        (i.e. the record will be revived). If an `errors` array is passed, the
        store will first fire a `record:commit:error` event on the record
        (including in nested stores), if already instantiated. If
        <O.Event#preventDefault> is called on the event object, the record will
        **not** be revived; it is up to the handler to then fix the record
        before it is recommitted.

        Parameters:
            storeKeys   - {String[]} The list of store keys of records for
                          which the destruction was not committed.
            isPermanent - {Boolean} (optional) Should the store try to commit
                          the changes again, or just revert to last known
                          committed state?
            errors      - {Object[]} (optional) An array of objects
                          representing the error in committing the store key in
                          the equivalent location in the *storeKeys* argument.

        Returns:
            {O.Store} Returns self.
    */
    sourceDidNotDestroy(storeKeys, isPermanent, errors) {
        const { _created, _destroyed } = this;

        for (let i = storeKeys.length - 1; i >= 0; i -= 1) {
            const storeKey = storeKeys[i];
            const status = this.getStatus(storeKey);
            if ((status & ~DIRTY) === (READY | NEW | COMMITTING)) {
                this.setStatus(storeKey, status & ~(COMMITTING | NEW));
                delete _created[storeKey];
            } else if (status & DESTROYED) {
                this.setStatus(storeKey, (status & ~COMMITTING) | DIRTY);
                _destroyed[storeKey] = '';
                if (
                    isPermanent &&
                    (!errors || !this._notifyRecordOfError(storeKey, errors[i]))
                ) {
                    this.undestroyRecord(storeKey);
                }
            } else {
                didError({
                    name: SOURCE_COMMIT_DESTROY_MISMATCH_ERROR,
                });
            }
        }
        if (this.autoCommit) {
            this.commitChanges();
        }
        return mayHaveChanges(this);
    },

    _notifyRecordOfError(storeKey, error) {
        const record = this._skToRecord[storeKey];
        let isDefaultPrevented = false;
        const event = new Event(error.type || 'error', record, error);
        if (record) {
            record.fire('record:commit:error', event);
        } else {
            // The event will normally bubble from the record to the store.
            // If no record, fire directly on the store in case there are
            // observers attached here.
            this.fire('record:commit:error', event);
        }
        isDefaultPrevented = event.defaultPrevented;
        this._nestedStores.forEach((store) => {
            isDefaultPrevented =
                store._notifyRecordOfError(storeKey, error) ||
                isDefaultPrevented;
        });
        return isDefaultPrevented;
    },
});

['on', 'once', 'off'].forEach((property) => {
    Store.prototype[property] = function (type, object, method) {
        if (typeof type !== 'string') {
            type = guid(type);
        }
        return EventTarget[property].call(this, type, object, method);
    };
});

export { Store };
