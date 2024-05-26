import { Class, isEqual, meta } from '../../core/Core.js';
import {
    // DIRTY => A preemptive update has been applied since the last fetch of
    // updates from the server was *initiated*. Therefore, any update we receive
    // may not cover all of the preemptives.
    DIRTY,
    EMPTY,
    // LOADING => An *update* is being fetched from the server
    LOADING,
    // OBSOLETE => The data on the server may have changed since the last update
    // was requested.
    OBSOLETE,
    READY,
} from '../record/Status.js';
import { Query } from './Query.js';

import '../../core/Array.js'; // For Array#binarySearch
/* { observes, property, nocache } from */
import '../../foundation/Decorators.js';

/**
    Enum: O.WindowedQuery-WindowState

    The state of each window in the query is represented as follows:

    WINDOW_EMPTY             - Initial state. The window has not even been
                               requested.
    WINDOW_REQUESTED         - The ids in the window have been requested
    WINDOW_LOADING           - The ids in the window are being loaded by the
                               source.
    WINDOW_READY             - The ids in the window are all loaded and ready.
    WINDOW_RECORDS_REQUESTED - The records in the window have been requested.
    WINDOW_RECORDS_LOADING   - The records in the window are loading.
    WINDOW_RECORDS_READY     - The records in the window are ready.
*/
const WINDOW_EMPTY = 0;
const WINDOW_REQUESTED = 1;
const WINDOW_LOADING = 2;
const WINDOW_READY = 4;
const WINDOW_RECORDS_REQUESTED = 8;
const WINDOW_RECORDS_LOADING = 16;
const WINDOW_RECORDS_READY = 32;

/**
    Method: O.WindowedQuery-sortLinkedArrays

    Sorts an array whilst performing the same swaps on a second array, so that
    if item x was in position i in array 1, and item y was in position i in
    array 2, then after this function has been called, if item x is in posiiton
    j in array 1, then item y will be in position j in array 2.

    The arrays are sorted in place.

    Parameters:
        a1 - {Array} The array to sort.
        a2 - {Array} The array to perform the same swaps on.
*/
const sortLinkedArrays = function (a1, a2) {
    const zipped = a1.map((item, i) => [item, a2[i]]);
    zipped.sort((a, b) => a[0] - b[0]);
    zipped.forEach((item, i) => {
        a1[i] = item[0];
        a2[i] = item[1];
    });
};

const mapIndexes = function (list, storeKeys) {
    const indexOf = {};
    const indexes = [];
    const listLength = list.length;
    const storeKeysLength = storeKeys.length;
    // Since building the map will be O(n log n), only bother if we're trying to
    // find the index for more than log(n) store keys.
    // The +1 ensures it is always at least 1, so that in the degenerative case
    // where storeKeysLength == 0, we never bother building the map
    // When listLength == 0, Math.log( 0 ) == -Infinity, which is converted to 0
    // by ~~ integer conversion.
    if (storeKeysLength < ~~Math.log(listLength) + 1) {
        for (let i = 0; i < storeKeysLength; i += 1) {
            indexes.push(list.indexOf(storeKeys[i]));
        }
    } else {
        for (let i = 0; i < listLength; i += 1) {
            const id = list[i];
            if (id) {
                indexOf[id] = i;
            }
        }
        for (let i = 0; i < storeKeysLength; i += 1) {
            const index = indexOf[storeKeys[i]];
            indexes.push(index === undefined ? -1 : index);
        }
    }
    return indexes;
};

/**
    Method: O.WindowedQuery-mergeSortedLinkedArrays

    Parameters:
        a1 - {Array}
        a2 - {Array}
        b1 - {Array}
        b2 - {Array}

    Returns:
        {[Array,Array]} A tuple of two arrays.
*/
const mergeSortedLinkedArrays = function (a1, a2, b1, b2) {
    const rA = [];
    const rB = [];
    let i = 0;
    let j = 0;
    const l1 = a1.length;
    const l2 = a2.length;

    // Take the smallest head element each time.
    while (i < l1 || j < l2) {
        if (j >= l2 || (i < l1 && a1[i] < a2[j])) {
            rA.push(a1[i]);
            rB.push(b1[i]);
            i += 1;
        } else {
            rA.push(a2[j]);
            rB.push(b2[j]);
            j += 1;
        }
    }
    return [rA, rB];
};

const adjustIndexes = function (
    removed,
    added,
    removedBefore,
    storeKeys,
    removedBeforeStoreKeys,
) {
    const resultIndexes = [];
    const resultStoreKeys = [];
    for (let i = 0, l = removed.length; i < l; i += 1) {
        // Take the item removed in the second update
        let index = removed[i];
        // And see how many items were added in the first update
        // before it
        const position = added.binarySearch(index);
        // If there was an item added in the first update at the exact same
        // position, we don't need to do anything as they cancel each other out.
        // Since update 2 is from the state left by update 1, the storeKeys
        // MUST be the same.
        if (index === added[position]) {
            continue;
        }
        // Otherwise, subtract the number of items added before it, as
        // these didn't exist in the original state.
        index -= position;
        // Now consider the indexes that were removed in the first
        // update. We need to increment the index for all indexes
        // before or equal to the index we're considering.
        for (
            let j = 0, ll = removedBefore.length;
            j < ll && index >= removedBefore[j];
            j += 1
        ) {
            index += 1;
        }
        // Now we have the correct index.
        resultIndexes.push(index);
        resultStoreKeys.push(storeKeys[i]);
    }
    return mergeSortedLinkedArrays(
        removedBefore,
        resultIndexes,
        removedBeforeStoreKeys,
        resultStoreKeys,
    );
};

const composeUpdates = function (u1, u2) {
    const removed = adjustIndexes(
        u2.removedIndexes,
        u1.addedIndexes,
        u1.removedIndexes,
        u2.removedStoreKeys,
        u1.removedStoreKeys,
    );
    const added = adjustIndexes(
        u1.addedIndexes,
        u2.removedIndexes,
        u2.addedIndexes,
        u1.addedStoreKeys,
        u2.addedStoreKeys,
    );

    return {
        removedIndexes: removed[0],
        removedStoreKeys: removed[1],
        addedIndexes: added[0],
        addedStoreKeys: added[1],
        truncateAtFirstGap: u1.truncateAtFirstGap || u2.truncateAtFirstGap,
        total: u2.total,
        upToId: u2.upToId,
    };
};

const invertUpdate = function (u) {
    let array = u.removedIndexes;
    u.removedIndexes = u.addedIndexes;
    u.addedIndexes = array;

    array = u.removedStoreKeys;
    u.removedStoreKeys = u.addedStoreKeys;
    u.addedStoreKeys = array;

    u.total = u.total + u.addedStoreKeys.length - u.removedStoreKeys.length;

    return u;
};

// Where (a,b) and (c,d) are ranges.
// and a < b and c < d.
const intersect = function (a, b, c, d) {
    return a < c ? c < b : a < d;
};

const updateIsEqual = function (u1, u2) {
    return (
        u1.total === u2.total &&
        isEqual(u1.addedIndexes, u2.addedIndexes) &&
        isEqual(u1.addedStoreKeys, u2.addedStoreKeys) &&
        isEqual(u1.removedIndexes, u2.removedIndexes) &&
        isEqual(u1.removedStoreKeys, u2.removedStoreKeys)
    );
};

// A window is determined to be still required if there is a range observer that
// intersects with any part of the window. The prefetch distance is added to the
// observer range.
const windowIsStillInUse = function (index, windowSize, prefetch, ranges) {
    const start = index * windowSize;
    const margin = prefetch * windowSize;
    for (let i = ranges.length - 1; i >= 0; i -= 1) {
        const range = ranges[i];
        const rangeStart = range.start || 0;
        if (!('end' in range)) {
            return true;
        }
        const rangeEnd = range.end;
        const rangeIntersectsWindow = intersect(
            start,
            start + windowSize,
            rangeStart - margin,
            rangeEnd + margin,
        );
        if (rangeIntersectsWindow) {
            return true;
        }
    }
    return false;
};

/**
    Class: O.WindowedQuery

    Extends: O.Query

    A windowed remote query represents a potentially very large array of records
    calculated by the server. Records are loaded in blocks (windows); for
    example, with a window size of 30, accessing any record at indexes 0--29
    will cause all records within that range to be loaded, but does not
    necessarily load anything else.

    The class also supports an efficient modification sequence system for
    calculating, transfering and applying delta updates as the results of the
    query changes.
*/
const WindowedQuery = Class({
    Name: 'WindowedQuery',

    Extends: Query,

    /**
        Property: O.WindowedQuery#windowSize
        Type: Number

        The number of records that make up one window.
    */
    windowSize: 30,

    windowCount: function () {
        const length = this.get('length');
        return length === null
            ? length
            : Math.floor((length - 1) / this.get('windowSize')) + 1;
    }.property('length'),

    /**
        Property: O.WindowedQuery#triggerPoint
        Type: Number

        If the record at an index less than this far from the end of a window is
        requested, the adjacent window will also be loaded (prefetching based on
        locality)
    */
    triggerPoint: 10,

    /**
        Property: O.WindowedQuery#optimiseFetching
        Type: Boolean

        If true, if a requested window is no longer either observed or adjacent
        to an observed window at the time <sourceWillFetchQuery> is called, the
        window is not actually requested.
    */
    optimiseFetching: false,

    /**
        Property: O.WindowedQuery#prefetch
        Type: Number

        The number of windows either side of an explicitly requested window, for
        which ids should be fetched.
    */
    prefetch: 1,

    /**
        Property: O.WindowedQuery#canGetDeltaUpdates
        Type: Boolean

        If the state is out of date, can the source fetch the delta of exactly
        what has changed, or does it just need to throw out the current list and
        refetch?
    */
    canGetDeltaUpdates: true,

    /**
        Property (private): O.WindowedQuery#_isAnExplicitIdFetch
        Type: Boolean

        This is set to true when an explicit request is made to fetch ids (e.g.
        through <O.Query#getStoreKeysForObjectsInRange>). This prevents
        the query from optimising away the request when it corresponds to a
        non-observed range in the query.
    */

    /**
        Property: O.WindowedQuery#allIdsAreLoaded
        Type: Boolean

        Do we have the complete list of ids for this query in memory?
        This is *not* currently observable.
    */
    allIdsAreLoaded: function () {
        const windowCount = this.get('windowCount');
        const windows = this._windows;
        if (windowCount === null) {
            return false;
        }
        for (let i = windowCount - 1; i >= 0; i -= 1) {
            if (!(windows[i] & WINDOW_READY)) {
                return false;
            }
        }
        return true;
    }
        .property()
        .nocache(),

    init: function (/* ...mixins */) {
        this._windows = [];
        this._indexOfRequested = [];
        this._waitingPackets = [];
        this._preemptiveUpdates = [];

        this._isAnExplicitIdFetch = false;

        WindowedQuery.parent.constructor.apply(this, arguments);
    },

    reset() {
        this._windows.length = 0;
        this._indexOfRequested.length = 0;
        this._waitingPackets.length = 0;
        this._preemptiveUpdates.length = 0;

        this._isAnExplicitIdFetch = false;

        WindowedQuery.parent.reset.call(this);
    },

    _toStoreKey: function () {
        const store = this.get('store');
        const accountId = this.get('accountId');
        const Type = this.get('Type');
        return (id) => store.getStoreKey(accountId, Type, id);
    }.property(),

    indexOfStoreKey(storeKey, from, callback) {
        const index = this._storeKeys.indexOf(storeKey, from);
        if (callback) {
            // If we have a callback and haven't found it yet, we need to keep
            // searching.
            if (index < 0) {
                // First check if the list is loaded
                if (this.get('allIdsAreLoaded')) {
                    // Everything loaded; the id simply isn't in it.
                    // index is -1.
                    callback(index);
                    return index;
                }
                // We're missing part of the list, so it may be in the missing
                // bit.
                const store = this.get('store');
                const id = store.getIdFromStoreKey(storeKey);
                this._indexOfRequested.push([
                    id,
                    () => {
                        callback(this._storeKeys.indexOf(storeKey, from));
                    },
                ]);
                this.get('source').fetchQuery(this);
            } else {
                callback(index);
            }
        }
        return index;
    },

    getStoreKeysForObjectsInRange(start, end, callback) {
        const length = this.get('length');
        let isComplete = true;

        if (length !== null) {
            if (start < 0) {
                start = 0;
            }
            if (end > length) {
                end = length;
            }

            const windows = this._windows;
            const windowSize = this.get('windowSize');
            let i = Math.floor(start / windowSize);
            const l = Math.floor((end - 1) / windowSize) + 1;

            for (; i < l; i += 1) {
                if (!(windows[i] & WINDOW_READY)) {
                    isComplete = false;
                    this._isAnExplicitIdFetch = true;
                    this.fetchWindow(i, false, 0);
                }
            }
        } else {
            isComplete = false;
        }

        if (isComplete) {
            callback(this._storeKeys.slice(start, end), start, end);
        } else {
            this._awaitingIdFetch.push([start, end, callback]);
        }
        return !isComplete;
    },

    // Fetches all ids and records in window.
    // If within trigger distance of window edge, fetches adjacent window as
    // well.
    fetchDataForObjectAt(index) {
        // Load all headers in window containing index.
        const windowSize = this.get('windowSize');
        const trigger = this.get('triggerPoint');
        const windowIndex = Math.floor(index / windowSize);
        const withinWindowIndex = index % windowSize;

        this.fetchWindow(windowIndex, true);

        // If within trigger distance of end of window, load next window
        // Otherwise, just fetch ids for the next window.
        if (withinWindowIndex < trigger) {
            this.fetchWindow(windowIndex - 1, true);
        }
        if (withinWindowIndex + trigger >= windowSize) {
            this.fetchWindow(windowIndex + 1, true);
        }
        return true;
    },

    /**
        Method: O.WindowedQuery#fetchWindow

        Fetches all records in the window with the index given. e.g. if the
        window size is 30, calling this with index 1 will load all records
        between positions 30 and 59 (everything 0-indexed).

        Also fetches the ids for all records in the window either side.

        Parameters:
            index        - {Number} The index of the window to load.
            fetchRecords - {Boolean}
            prefetch     - {Number} (optional)

        Returns:
            {O.WindowedQuery} Returns self.
    */
    fetchWindow(index, fetchRecords, prefetch) {
        let status = this.get('status');
        const windows = this._windows;
        let doFetch = false;

        if (status & OBSOLETE) {
            this.fetch();
        }

        if (prefetch === undefined) {
            prefetch = this.get('prefetch');
        }

        let i = Math.max(0, index - prefetch);
        const l = Math.min(index + prefetch + 1, this.get('windowCount') || 0);

        for (; i < l; i += 1) {
            status = windows[i] || 0;
            if (status === WINDOW_EMPTY) {
                status = WINDOW_REQUESTED;
                doFetch = true;
            }
            if (
                i === index &&
                fetchRecords &&
                status < WINDOW_RECORDS_REQUESTED
            ) {
                if (status & WINDOW_READY && this.checkIfWindowIsFetched(i)) {
                    status = WINDOW_READY | WINDOW_RECORDS_READY;
                } else {
                    status = status | WINDOW_RECORDS_REQUESTED;
                    doFetch = true;
                }
            }
            windows[i] = status;
        }
        if (doFetch) {
            this.get('source').fetchQuery(this);
        }
        return this;
    },

    // Precondition: all ids are known
    checkIfWindowIsFetched(index) {
        const store = this.get('store');
        const windowSize = this.get('windowSize');
        const list = this._storeKeys;
        let i = index * windowSize;
        const l = Math.min(i + windowSize, this.get('length'));
        let status;
        for (; i < l; i += 1) {
            status = store.getStatus(list[i]);
            if (
                !(status & READY) ||
                (status & OBSOLETE && !(status & LOADING))
            ) {
                return false;
            }
        }
        return true;
    },

    /**
        Method: O.WindowedQuery#recalculateFetchedWindows

        Recalculates whether the ids and records are fetched for windows,
        for all windows with an index equal or greater than that of the window
        containing the start index given.

        Although the information on whether the records for a window are loaded
        is reset, it is not recalculated; this will be done on demand when a
        fetch is made for the window.

        Parameters:
            start - {Number} The index of the first record to have changed (i.e.
                    invalidate all window information starting from the window
                    containing this index).
            length - {Number} The new length of the list.
    */
    recalculateFetchedWindows(start, length) {
        if (!start) {
            start = 0;
        }
        if (length === undefined) {
            length = this.get('length');
        }

        const windowSize = this.get('windowSize');
        const windows = this._windows;
        const list = this._storeKeys;
        // Start at last window index
        let windowIndex = Math.floor((length - 1) / windowSize);
        // And last list index
        let listIndex = length - 1;

        // Convert start from list index to window index.
        start = Math.floor(start / windowSize);

        // Truncate any non-existant windows.
        windows.length = windowIndex + 1;

        // Unless there's something defined for all properties between
        // listIndex and windowIndex we must remove the WINDOW_READY flag.
        // We always remove WINDOWS_RECORDS_READY flag, and calculate this when
        // the window is requested.
        while (windowIndex >= start) {
            const target = windowIndex * windowSize;
            // Always remove WINDOWS_RECORDS_READY flag; this is recalculated
            // lazily when the window is fetched.
            let status = (windows[windowIndex] || 0) & ~WINDOW_RECORDS_READY;
            // But the window might be ready, so add the WINDOW_READY flag and
            // then remove it if we find a gap in the window.
            status |= WINDOW_READY;
            while (listIndex >= target) {
                if (!list[listIndex]) {
                    status = status & ~WINDOW_READY;
                    break;
                }
                listIndex -= 1;
            }
            // Set the new status
            windows[windowIndex] = status;
            listIndex = target - 1;
            windowIndex -= 1;
        }
        return this;
    },

    // ---- Updates ---

    _normaliseUpdate(update) {
        const list = this._storeKeys;
        let removedStoreKeys = update.removed;
        let removedIndexes = mapIndexes(list, removedStoreKeys);
        const addedStoreKeys = [];
        const addedIndexes = [];
        const added = update.added;
        let i;
        let l;

        sortLinkedArrays(removedIndexes, removedStoreKeys);
        for (i = 0; removedIndexes[i] === -1; i += 1) {
            // Do nothing (we just want to find the first index of known
            // position).
        }
        // If we have some ids we don't know the index of.
        if (i) {
            // Ignore them.
            removedIndexes = removedIndexes.slice(i);
            removedStoreKeys = removedStoreKeys.slice(i);
        }
        // But truncate at first gap.
        const truncateAtFirstGap = !!i;

        for (i = 0, l = added.length; i < l; i += 1) {
            const { index, storeKey } = added[i];
            const j = removedStoreKeys.indexOf(storeKey);

            if (
                j > -1 &&
                removedIndexes[j] - j + addedIndexes.length === index
            ) {
                removedIndexes.splice(j, 1);
                removedStoreKeys.splice(j, 1);
            } else {
                addedIndexes.push(index);
                addedStoreKeys.push(storeKey);
            }
        }

        return {
            removedIndexes,
            removedStoreKeys,
            addedIndexes,
            addedStoreKeys,
            truncateAtFirstGap,
            total:
                update.total !== undefined
                    ? update.total
                    : this.get('length') -
                      removedIndexes.length +
                      addedIndexes.length,
            upToId: update.upToId,
        };
    },

    _applyUpdate(args) {
        const removedIndexes = args.removedIndexes;
        const removedStoreKeys = args.removedStoreKeys;
        const removedLength = removedStoreKeys.length;
        const addedIndexes = args.addedIndexes;
        const addedStoreKeys = args.addedStoreKeys;
        const addedLength = addedStoreKeys.length;
        const list = this._storeKeys;
        let recalculateFetchedWindows = !!(addedLength || removedLength);
        const oldLength = this.get('length');
        const newLength = args.total;
        let firstChange = oldLength;
        let listLength = list.length;

        // --- Check upToId ---

        // upToId is the last item id the updates are to. Anything after here
        // may have changed, but won't be in the updates, so we need to truncate
        // the list to ensure it doesn't get into an inconsistent state.
        // If we can't find the id, we have to reset.
        if (args.upToId) {
            const index = list.lastIndexOf(args.upToId) + 1;
            if (index) {
                if (index !== listLength) {
                    recalculateFetchedWindows = true;
                    list.length = listLength = index;
                    if (index < firstChange) {
                        firstChange = index;
                    }
                }
            } else {
                return this.reset();
            }
        }

        // --- Remove items from list ---

        for (let i = removedLength - 1; i >= 0; i -= 1) {
            const index = removedIndexes[i];
            list.splice(index, 1);
            if (index < firstChange) {
                firstChange = index;
            }
        }

        if (args.truncateAtFirstGap) {
            // Truncate the list so it does not contain any gaps; anything after
            // the first gap may be incorrect as a record may have been removed
            // from that gap.
            let i = 0;
            while (list[i]) {
                i += 1;
            }
            list.length = listLength = i;
            if (i < firstChange) {
                firstChange = i;
            }
        }

        // --- Add items to list ---

        // If the index is past the end of the array, you can't use splice
        // (unless you set the length of the array first), so use standard
        // assignment.
        for (let i = 0, l = addedLength; i < l; i += 1) {
            const index = addedIndexes[i];
            const storeKey = addedStoreKeys[i];
            if (index >= listLength) {
                list[index] = storeKey;
                listLength = index + 1;
            } else {
                list.splice(index, 0, storeKey);
                listLength += 1;
            }
            if (index < firstChange) {
                firstChange = index;
            }
        }

        // --- Recalculate fetched windows ---

        // Anything from the firstChange index onwards may have changed, so we
        // have to recalculate which windows that cover indexes from this point
        // onwards we now have ids for. We only bother to recalculate whether we
        // have a complete set of ids; if the window needs an update or does
        // not have all records in memory, this will be recalculated when it is
        // accessed.
        if (recalculateFetchedWindows) {
            this.recalculateFetchedWindows(firstChange, newLength);
        }

        // --- Broadcast changes ---

        this.set('length', newLength).rangeDidChange(
            firstChange,
            Math.max(oldLength, newLength),
        );

        // For selection purposes, list view will need to know the ids of those
        // which were removed. Also, keyboard indicator will need to know the
        // indexes of those removed or added.
        this.fire('query:updated', {
            query: this,
            removed: removedStoreKeys,
            removedIndexes,
            added: addedStoreKeys,
            addedIndexes,
        });

        // --- And process any waiting data packets ---

        this._applyWaitingPackets();

        return this;
    },

    _applyWaitingPackets() {
        let didDropPackets = false;
        const waitingPackets = this._waitingPackets;
        const queryState = this.get('queryState');
        let packet;

        for (let i = waitingPackets.length - 1; i >= 0; i -= 1) {
            packet = waitingPackets.shift();
            // If these values aren't now the same, the packet must
            // be OLDER than our current queryState, so just discard.
            if (packet.queryState !== queryState) {
                // But also fetch everything missing in observed range, to
                // ensure we have the required data
                didDropPackets = true;
            } else {
                this.sourceDidFetchIds(packet);
            }
        }
        if (didDropPackets) {
            this._fetchObservedWindows();
        }
    },

    _fetchObservedWindows() {
        const ranges = meta(this).rangeObservers;
        const length = this.get('length');
        const windowSize = this.get('windowSize');
        if (ranges) {
            for (let i = ranges.length - 1; i >= 0; i -= 1) {
                const range = ranges[i].range;
                let observerStart = range.start || 0;
                let observerEnd = 'end' in range ? range.end : length;
                if (observerStart < 0) {
                    observerStart += length;
                }
                if (observerEnd < 0) {
                    observerEnd += length;
                }
                let firstWindow = Math.floor(observerStart / windowSize);
                const lastWindow = Math.floor((observerEnd - 1) / windowSize);
                for (; firstWindow <= lastWindow; firstWindow += 1) {
                    this.fetchWindow(firstWindow, true);
                }
            }
        }
    },

    /**
        Method: O.WindowedQuery#clientDidGenerateUpdate

        Call this to update the list with what you think the server will do
        after an action has committed. The change will be applied immediately,
        making the UI more responsive, and be checked against what actually
        happened next time an update arrives. If it turns out to be wrong the
        list will be reset, but in most cases it should appear more efficient.

        removed - {String[]} The store keys of all records to delete.
        added   - {Object[]} A list of objects with index and storeKey
                  properties, in ascending order of index, for all records to be
                  inserted.

        Parameters:
            update - {Object} The removed/added updates to make.

        Returns:
            {O.WindowedQuery} Returns self.
    */
    clientDidGenerateUpdate(update) {
        update = this._normaliseUpdate(update);
        // Ignore completely any ids we don't have.
        update.truncateAtFirstGap = false;
        this._applyUpdate(update);
        this._preemptiveUpdates.push(update);
        this.set('status', this.get('status') | DIRTY);
        this.setObsolete();
        return this;
    },

    /**
        Method: O.WindowedQuery#sourceDidFetchUpdate

        The source should call this when it fetches a delta update for the
        query. The args object should contain the following properties:

        newQueryState - {String} The state this delta updates the remote query
                        to.
        oldQueryState - {String} The state this delta updates the remote query
                        from.
        removed  - {String[]} The ids of all records removed since
                   oldQueryState.
        added    - {{index: Number, id: String}[]} A list of { index, id }
                   objects, in ascending order of index, for all records added
                   since oldQueryState.
        upToId   - {String} (optional) As an optimisation, updates may only be
                   for the first portion of a list, up to a certain id. This is
                   the last id which is included in the range covered by the
                   updates; any information past this id must be discarded, and
                   if the id can't be found the list must be reset.
        total    - {Number} (optional) The total number of records in the list.

        Parameters:
            update - {Object} The delta update (see description above).

        Returns:
            {O.WindowedQuery} Returns self.
    */
    sourceDidFetchUpdate(update) {
        const queryState = this.get('queryState');
        const status = this.get('status');
        const preemptives = this._preemptiveUpdates;
        const preemptivesLength = preemptives.length;

        // We've got an update, so we're no longer in the LOADING state.
        this.set('status', status & ~LOADING);

        // Check we've not already got this update.
        if (queryState === update.newQueryState) {
            if (preemptivesLength && !(status & DIRTY)) {
                const allPreemptives = preemptives.reduce(composeUpdates);
                this._applyUpdate(invertUpdate(allPreemptives));
                preemptives.length = 0;
            }
            return this;
        }
        // We can only update from our old query state.
        if (queryState !== update.oldQueryState) {
            return this.setObsolete();
        }
        // Set new query state
        this.set('queryState', update.newQueryState);

        // Map ids to store keys
        const toStoreKey = this.get('_toStoreKey');
        const added = update.added.map((item) => ({
            index: item.index,
            storeKey: toStoreKey(item.id),
        }));
        const seenStorekey = {};
        const removed = update.removed.reduce((_removed, id) => {
            // Need to deduplicate removed; if an id is rewritten, we keep the
            // old id => store key mapping so we can remove it from a query.
            // However, the server may return both the old id and the new id
            // as "removed" in the update (along with the new id being "added"
            // in the correct position), which results in it being removed from
            // the query rather than moved to the correct place if we don't
            // deduplicate.
            const storeKey = toStoreKey(id);
            if (!seenStorekey[storeKey]) {
                seenStorekey[storeKey] = true;
                _removed.push(storeKey);
            }
            return _removed;
        }, []);
        const upToId = update.upToId && toStoreKey(update.upToId);
        const total = update.total;

        if (!preemptivesLength) {
            this._applyUpdate(
                this._normaliseUpdate({
                    removed,
                    added,
                    total,
                    upToId,
                }),
            );
        } else {
            // 1. Compose all preemptives:
            // [p1, p2, p3] -> [p1, p1 + p2, p1 + p2 + p3 ]
            const composed = [preemptives[0]];
            for (let i = 1; i < preemptivesLength; i += 1) {
                composed[i] = composeUpdates(composed[i - 1], preemptives[i]);
            }

            // 2. Normalise the update from the server. This is trickier
            // than normal, as we need to determine what the indexes of the
            // removed store keys were in the previous query state.
            const removedIndexes = [];
            const removedStoreKeys = [];
            const normalisedUpdate = {
                removedIndexes,
                removedStoreKeys,
                addedIndexes: added.map((item) => item.index),
                addedStoreKeys: added.map((item) => item.storeKey),
                truncateAtFirstGap: false,
                total,
                upToId,
            };

            // Find the removedIndexes for our update. If they were removed
            // in the composed preemptive, we have the index. Otherwise, we
            // need to search for the store key in the current list then
            // compose the result with the preemptive in order to get the
            // original index.
            const list = this._storeKeys;
            const indexesToRemove = [];
            const storeKeysToRemove = [];
            let wasSuccessfulPreemptive = false;

            let allPreemptives = composed[preemptivesLength - 1];
            for (let i = 0, l = removed.length; i < l; i += 1) {
                const storeKey = removed[i];
                let index = allPreemptives.removedStoreKeys.indexOf(storeKey);
                if (index > -1) {
                    removedIndexes.push(allPreemptives.removedIndexes[index]);
                    removedStoreKeys.push(storeKey);
                } else {
                    index = list.indexOf(storeKey);
                    if (index > -1) {
                        indexesToRemove.push(index);
                        storeKeysToRemove.push(storeKey);
                    } else {
                        normalisedUpdate.truncateAtFirstGap = true;
                    }
                }
            }
            if (storeKeysToRemove.length) {
                const composedUpdate = composeUpdates(allPreemptives, {
                    removedIndexes: indexesToRemove,
                    removedStoreKeys: storeKeysToRemove,
                    addedIndexes: [],
                    addedStoreKeys: [],
                });
                const composedRemovedSKs = composedUpdate.removedStoreKeys;
                const composedRemovedIndexes = composedUpdate.removedIndexes;
                for (let i = 0, l = storeKeysToRemove.length; i < l; i += 1) {
                    const storeKey = storeKeysToRemove[i];
                    const index = composedRemovedSKs.indexOf(storeKey);
                    if (index > -1) {
                        removedIndexes.push(composedRemovedIndexes[index]);
                        removedStoreKeys.push(storeKey);
                    } else {
                        normalisedUpdate.truncateAtFirstGap = true;
                    }
                }
            }
            sortLinkedArrays(removedIndexes, removedStoreKeys);

            // Now remove any idempotent operations
            const addedIndexes = normalisedUpdate.addedIndexes;
            const addedStoreKeys = normalisedUpdate.addedStoreKeys;
            for (let i = addedIndexes.length - 1; i >= 0; i -= 1) {
                const storeKey = addedStoreKeys[i];
                const j = removedStoreKeys.indexOf(storeKey);
                // j => Number of items removed before this one
                // i => Number of items added before this one
                // Therefore old index - j + i => new index. If it is being
                // added at this index, the whole operation is inert.
                if (j > -1 && removedIndexes[j] - j + i === addedIndexes[i]) {
                    removedIndexes.splice(j, 1);
                    removedStoreKeys.splice(j, 1);
                    addedIndexes.splice(i, 1);
                    addedStoreKeys.splice(i, 1);
                }
            }

            // 3. We now have a normalised update from the server. We
            // compare this to each composed state of our preemptive
            // updates. If it matches any completely, we guessed correctly
            // and the list is already up to date. We just need to set the
            // status and apply any waiting packets. If it doesn't match, we
            // remove all our preemptive updates and apply the update from
            // the server instead, to ensure we end up in a consistent
            // state.

            // If nothing actually changed in this update, we're done,
            // but we can apply any waiting packets.
            if (!removedStoreKeys.length && !addedStoreKeys.length) {
                wasSuccessfulPreemptive = true;
            } else {
                for (let i = composed.length - 1; i >= 0; i -= 1) {
                    if (updateIsEqual(normalisedUpdate, composed[i])) {
                        // Remove the preemptives that have now been
                        // confirmed by the server
                        preemptives.splice(0, i + 1);
                        wasSuccessfulPreemptive = true;
                        break;
                    }
                }
            }
            if (wasSuccessfulPreemptive) {
                // Truncate if needed
                if (normalisedUpdate.truncateAtFirstGap) {
                    let i = 0;
                    while (list[i]) {
                        i += 1;
                    }
                    if (list.length !== i) {
                        list.length = i;
                        this.recalculateFetchedWindows(i);
                    }
                }
                // If we aren't in the dirty state, we shouldn't have any
                // preemptive updates left. If we do, remove them.
                if (!(status & DIRTY) && preemptives.length) {
                    allPreemptives = preemptives.reduce(composeUpdates);
                    this._applyUpdate(invertUpdate(allPreemptives));
                    preemptives.length = 0;
                } else {
                    this._applyWaitingPackets();
                }
            } else {
                // Undo all preemptive updates and apply server change
                // instead.
                preemptives.length = 0;
                this._applyUpdate(
                    composeUpdates(
                        invertUpdate(allPreemptives),
                        normalisedUpdate,
                    ),
                );
            }
        }
        return this;
    },

    /**
        Method: O.WindowedQuery#sourceDidFetchIds

        The source should call this when it fetches a portion of the id list for
        this query. The args object should contain:

        queryState - {String} The queryState of the server when this slice was
                     taken.
        ids        - {String[]} The list of ids.
        position   - {Number} The index in the query of the first id in ids.
        total      - {Number} The total number of records in the query.

        Parameters:
            args - {Object} The portion of the overall id list. See above for
                   details.

        Returns:
            {O.WindowedQuery} Returns self.
    */
    sourceDidFetchIds(args) {
        const queryState = this.get('queryState');
        const status = this.get('status');
        const oldLength = this.get('length') || 0;
        const canGetDeltaUpdates = this.get('canGetDeltaUpdates');
        let position = args.position;
        let total = args.total;
        const ids = args.ids;
        let length = ids.length;
        const list = this._storeKeys;
        const windows = this._windows;
        const preemptives = this._preemptiveUpdates;
        let informAllRangeObservers = false;
        let beginningOfWindowIsFetched = true;

        // If the query state does not match, the list has changed since we last
        // queried it, so we must get the intervening updates first.
        if (queryState && queryState !== args.queryState) {
            if (canGetDeltaUpdates) {
                this._waitingPackets.push(args);
                return this.setObsolete().fetch();
            } else {
                list.length = windows.length = preemptives.length = 0;
                informAllRangeObservers = true;
            }
        }
        this.set('queryState', args.queryState);

        // Map ids to store keys
        const toStoreKey = this.get('_toStoreKey');
        const storeKeys = ids.map(toStoreKey);

        // Need to adjust for preemptive updates
        if (preemptives.length) {
            // Adjust store keys, position, length
            const allPreemptives = preemptives.reduce(composeUpdates);
            const addedIndexes = allPreemptives.addedIndexes;
            const addedStoreKeys = allPreemptives.addedStoreKeys;
            const removedIndexes = allPreemptives.removedIndexes;

            if (canGetDeltaUpdates) {
                for (let i = removedIndexes.length - 1; i >= 0; i -= 1) {
                    const index = removedIndexes[i] - position;
                    if (index < length) {
                        if (index >= 0) {
                            storeKeys.splice(index, 1);
                            length -= 1;
                        } else {
                            position -= 1;
                        }
                    }
                }
                for (let i = 0, l = addedIndexes.length; i < l; i += 1) {
                    const index = addedIndexes[i] - position;
                    if (index <= 0) {
                        position += 1;
                    } else if (index < length) {
                        storeKeys.splice(index, 0, addedStoreKeys[i]);
                        length += 1;
                    } else {
                        break;
                    }
                }
                total = allPreemptives.total;
            } else {
                // The preemptive change we made was clearly incorrect as no
                // change has actually occurred, so we need to unwind it.
                this._applyUpdate(invertUpdate(allPreemptives));
                preemptives.length = 0;
            }
        }

        // Calculate end index, as length will be destroyed later
        const end = position + length;

        // Insert store keys into list
        for (let i = 0; i < length; i += 1) {
            list[position + i] = storeKeys[i];
        }

        // Have we fetched any windows?
        const windowSize = this.get('windowSize');
        let windowIndex = Math.floor(position / windowSize);
        const withinWindowIndex = position % windowSize;
        if (withinWindowIndex) {
            for (
                let i = windowIndex * windowSize, l = i + withinWindowIndex;
                i < l;
                i += 1
            ) {
                if (!list[i]) {
                    beginningOfWindowIsFetched = false;
                    break;
                }
            }
            if (beginningOfWindowIsFetched) {
                length += withinWindowIndex;
            } else {
                windowIndex += 1;
                length -= windowSize - withinWindowIndex;
            }
        }
        // Now, for each set of windowSize records, we have a complete window.
        while ((length -= windowSize) >= 0) {
            windows[windowIndex] |= WINDOW_READY;
            windowIndex += 1;
        }
        // Need to check if the final window was loaded (may not be full-sized).
        length += windowSize;
        if (length && end === total && length === total % windowSize) {
            windows[windowIndex] |= WINDOW_READY;
        }

        // All that's left is to inform observers of the changes.
        return this.beginPropertyChanges()
            .set('length', total)
            .set('status', READY | (status & (DIRTY | LOADING | OBSOLETE)))
            .endPropertyChanges()
            .rangeDidChange(
                informAllRangeObservers ? 0 : position,
                informAllRangeObservers ? Math.max(oldLength, end) : end,
            )
            .fire('query:idsLoaded');
    },

    sourceWillFetchQuery() {
        // If optimise and no longer observed -> remove request
        // Move from requested -> loading
        const windowSize = this.get('windowSize');
        const windows = this._windows;
        const isAnExplicitIdFetch = this._isAnExplicitIdFetch;
        const indexOfRequested = this._indexOfRequested;
        const refreshRequested = this._refresh;
        const recordRequests = [];
        const idRequests = [];
        const optimiseFetching = this.get('optimiseFetching');
        const ranges = (meta(this).rangeObservers || []).map(
            (observer) => observer.range,
        );
        const fetchAllObservedIds =
            refreshRequested && !this.get('canGetDeltaUpdates');
        const prefetch = this.get('prefetch');

        this._isAnExplicitIdFetch = false;
        this._indexOfRequested = [];
        this._refresh = false;
        let rPrev;
        let iPrev;

        for (let i = 0, l = windows.length; i < l; i += 1) {
            let status = windows[i];
            if (status & (WINDOW_REQUESTED | WINDOW_RECORDS_REQUESTED)) {
                const inUse =
                    !optimiseFetching ||
                    windowIsStillInUse(i, windowSize, prefetch, ranges);
                if (status & WINDOW_RECORDS_REQUESTED) {
                    status &= ~WINDOW_RECORDS_REQUESTED;
                    if (inUse) {
                        const start = i * windowSize;
                        if (rPrev && rPrev.start + rPrev.count === start) {
                            rPrev.count += windowSize;
                        } else {
                            recordRequests.push(
                                (rPrev = {
                                    start,
                                    count: windowSize,
                                }),
                            );
                        }
                        status |= WINDOW_LOADING;
                        status |= WINDOW_RECORDS_LOADING;
                    }
                    // If not requesting records and an explicit id fetch, leave
                    // WINDOW_REQUESTED flag set the ids are still requested.
                    if (inUse || !isAnExplicitIdFetch) {
                        status &= ~WINDOW_REQUESTED;
                    } else {
                        status |= WINDOW_REQUESTED;
                    }
                }
                if (status & WINDOW_REQUESTED) {
                    if (inUse || isAnExplicitIdFetch) {
                        const start = i * windowSize;
                        if (iPrev && iPrev.start + iPrev.count === start) {
                            iPrev.count += windowSize;
                        } else {
                            idRequests.push(
                                (iPrev = {
                                    start,
                                    count: windowSize,
                                }),
                            );
                        }
                        status |= WINDOW_LOADING;
                    }
                    status &= ~WINDOW_REQUESTED;
                }
            } else if (fetchAllObservedIds) {
                const inUse = windowIsStillInUse(
                    i,
                    windowSize,
                    prefetch,
                    ranges,
                );
                if (inUse) {
                    const start = i * windowSize;
                    if (iPrev && iPrev.start + iPrev.count === start) {
                        iPrev.count += windowSize;
                    } else {
                        idRequests.push(
                            (iPrev = {
                                start,
                                count: windowSize,
                            }),
                        );
                    }
                }
            }
            windows[i] = status;
        }

        if (refreshRequested || this.is(EMPTY)) {
            let status = this.get('status');
            status |= LOADING;
            status &= ~OBSOLETE;
            // If we have applied pre-emptive updates since the last refresh,
            // and the store still has changes for this type when this is
            // fetched we must not clear the DIRTY flag, because the change
            // that caused the pre-emptive update may still not be committed
            // from the store to the source (if there was already a commit
            // happening, it can get backed up by one round trip). We'll
            // try again after this JMAP request has finished.
            if (
                status & DIRTY &&
                !this.get('store').hasChangesForType(this.get('Type'))
            ) {
                status &= ~DIRTY;
            }
            this.set('status', status);
        }

        return {
            ids: idRequests,
            records: recordRequests,
            indexOf: indexOfRequested,
            refresh: refreshRequested,
            callback: () => {
                this._windows = this._windows.map(
                    (status) =>
                        status & ~(WINDOW_LOADING | WINDOW_RECORDS_LOADING),
                );
                this.set('status', this.get('status') & ~LOADING);
                if (this.is(DIRTY) && !this.is(OBSOLETE)) {
                    this.setObsolete();
                }
            },
        };
    },
});

export { WindowedQuery };
