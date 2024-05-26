import { meta } from '../core/Core.js';

/**
    Mixin: O.ObservableRange

    The ObservableRange mixin adds support for observing an (integer-based)
    numerical range of keys to an observable object. The object is expected
    to have the ObservableProps mixin applied and have a length property.
*/

const ObservableRange = {
    /**
        Method: O.ObservableRange#rangeDidChange

        Notifies observers that are observing a range which intersects the range
        that has changed. Also notifies any observers observing an individual
        number (via <O.ObservableProps#addObserverForKey>) and any observers
        looking out for a change to `[]` (enumerable content did change).

        Parameters:
            start - {Number} The index of the first value in the range to have
                    changed (indexed from 0).
            end   - {Number} The index of one past the last value in the range
                    to have changed.

        Returns:
            {O.ObservableRange} Returns self.
    */
    rangeDidChange(start, end) {
        if (end === undefined) {
            end = start + 1;
        }
        const metadata = meta(this);
        const observers = metadata.observers;
        for (const key in observers) {
            if (observers[key]) {
                const index = parseInt(key, 10);
                if (start <= index && index < end) {
                    this.propertyDidChange(key);
                }
            }
        }
        const enumerableLength = this.get('length') || 0;
        const rangeObservers = metadata.rangeObservers;
        const l = rangeObservers ? rangeObservers.length : 0;
        for (let i = 0; i < l; i += 1) {
            const observer = rangeObservers[i];
            const range = observer.range;
            let observerStart = range.start || 0;
            let observerEnd =
                'end' in range ? range.end : Math.max(enumerableLength, end);
            if (observerStart < 0) {
                observerStart += enumerableLength;
            }
            if (observerEnd < 0) {
                observerEnd += enumerableLength;
            }
            if (observerStart < end && observerEnd > start) {
                observer.object[observer.method](this, start, end);
            }
        }
        this.computedPropertyDidChange('[]');
        return this;
    },

    /**
        Method: O.ObservableRange#addObserverForRange

        Registers an object and a method to be called on that object whenever an
        integer-referenced property in the given range changes. Note, the range
        is 'live'; you can change the start/end values in the object at any time
        and immediately receive notifications of updates in the new range.
        Negative values for start or end are allowed, and are treated as offsets
        from the end of the current length of this object, with -1 being the
        last item.

        Parameters:
            range  - {Object} The range to observe. May have either, both or
                     none of start and end properties. These are numerical
                     values, indexed from 0, negative values index from the end
                     of the enumerable object. If start is omitted it is taken
                     to be 0 (the first element in the enumerable). If end is
                     omitted it is taken to be the length of the enumerable.
                     start is inclusive and end is exclusive, e.g. {start: 1,
                     end: 2} will only fire if index 1 changes.
            object - {Object} The object on which to call the callback method.
            method - {String} The name of the callback method.

        Returns:
            {O.ObservableRange} Returns self.
    */
    addObserverForRange(range, object, method) {
        const metadata = meta(this);
        (metadata.rangeObservers || (metadata.rangeObservers = [])).push({
            range,
            object,
            method,
        });
        return this;
    },

    /**
        Method: O.ObservableRange#removeObserverForRange

        Stops callbacks to an object/method when content changes occur within
        the range. Note, the range object passed must be the same as that passed
        for addObserverForRange, not just have the same properties (these could
        have changed due to the support for live updating of the observed range.
        See <O.ObservableRange#addObserverForRange> description).

        Parameters:
            range  - {Object} The range which is being observed.
            object - {Object} The object which is observing it.
            method - {String} The name of the callback method on the observer
                     object.

        Returns:
            {O.ObservableRange} Returns self.
    */
    removeObserverForRange(range, object, method) {
        const metadata = meta(this);
        const rangeObservers = metadata.rangeObservers;
        const newObservers = rangeObservers
            ? rangeObservers.filter(
                  (item) =>
                      item.range !== range ||
                      item.object !== object ||
                      item.method !== method,
              )
            : [];
        if (!newObservers.length) {
            metadata.rangeObservers = null;
        } else if (newObservers.length !== rangeObservers.length) {
            metadata.rangeObservers = newObservers;
        }
        return this;
    },

    /**
        Method: O.ObservableRange#hasRangeObservers

        Returns true a range is being observed on the object by another object.

        Returns:
            {Boolean} Does the object have any range observers?
    */
    hasRangeObservers() {
        const rangeObservers = meta(this).rangeObservers;
        const length = rangeObservers ? rangeObservers.length : 0;
        for (let i = length - 1; i >= 0; i -= 1) {
            const object = rangeObservers[i].object;
            if (object && object !== this) {
                return true;
            }
        }
        return false;
    },
};

export { ObservableRange };
