import { loc } from './i18n.js';

/**
    Function: Date.formatDuration

    Formats the duration given into a localised string, e.g. "5 hours" or
    "3 weeks 2 days".

    Parameters:
        durationInMS - The duration in milliseconds to format.
        approx       - If true, only show most significant unit.

    Returns:
        {String} The formatted duration.
*/
const formatDuration = function (durationInMS, approx) {
    const durationInSeconds = Math.abs(Math.floor(durationInMS / 1000));
    let time;

    if (durationInSeconds < 60) {
        if (approx) {
            time = loc('less than a minute');
        } else {
            time = loc(
                '{value1, plural, one {# second} other {# seconds}}',
                durationInSeconds,
            );
        }
    } else if (durationInSeconds < 60 * 60) {
        time = loc(
            '{value1, plural, one {# minute} other {# minutes}}',
            ~~(durationInSeconds / 60),
        );
    } else if (durationInSeconds < 60 * 60 * 24) {
        let hours;
        let minutes;
        if (approx) {
            hours = Math.round(durationInSeconds / (60 * 60));
            minutes = 0;
        } else {
            hours = ~~(durationInSeconds / (60 * 60));
            minutes = ~~((durationInSeconds / 60) % 60);
        }
        time = loc(
            '{value1, plural, one {# hour} other {# hours} =0 {}} {value2, plural, one {# minute} other {# minutes} =0 {}}',
            hours,
            minutes,
        );
    } else if (
        approx
            ? durationInSeconds < 60 * 60 * 24 * 21
            : durationInSeconds < 60 * 60 * 24 * 7
    ) {
        let days;
        let hours;
        if (approx) {
            days = Math.round(durationInSeconds / (60 * 60 * 24));
            hours = 0;
        } else {
            days = ~~(durationInSeconds / (60 * 60 * 24));
            hours = ~~((durationInSeconds / (60 * 60)) % 24);
        }
        time = loc(
            '{value1, plural, one {# day} other {# days} =0 {}} {value2, plural, one {# hour} other {# hours} =0 {}}',
            days,
            hours,
        );
    } else {
        let weeks;
        let days;
        if (approx) {
            weeks = Math.round(durationInSeconds / (60 * 60 * 24 * 7));
            days = 0;
        } else {
            weeks = ~~(durationInSeconds / (60 * 60 * 24 * 7));
            days = ~~(durationInSeconds / (60 * 60 * 24)) % 7;
        }
        time = loc(
            '{value1, plural, one {# week} other {# weeks} =0 {}} {value2, plural, one {# day} other {# days} =0 {}}',
            weeks,
            days,
        );
    }
    return time.trim();
};
Date.formatDuration = formatDuration;

/**
    Method: Date#relativeTo

    Returns the difference in time between the date given in the sole
    argument (or now if not supplied) and this date, in a human friendly,
    localised form. e.g. 5 hours 3 minutes ago.

    Parameters:
        date   - {Date} Date to compare it to.
        approx - {Boolean} (optional) If true, only return a string for the
                 most significant part of the relative time (e.g. just "5
                 hours ago" instead of "5 hours 34 minutes ago").
        mustNotBeFuture - {Boolean} (optional) If true and a date is supplied in
                          the future, it is assumed this is due to clock skew
                          and the string "just now" is always returned.

    Returns:
        {String} Relative date string.
*/
Date.prototype.relativeTo = function (date, approx, mustNotBeFuture) {
    if (!date) {
        date = new Date();
    }

    let duration = date - this;
    const isFuture = duration < 0;
    let time;

    if (isFuture) {
        duration = -duration;
    }
    if (!duration || (isFuture && mustNotBeFuture)) {
        return loc('just now');
        // Less than a day
    } else if (duration < 1000 * 60 * 60 * 24) {
        time = formatDuration(duration, approx);
        // Less than 6 weeks
    } else if (duration < 1000 * 60 * 60 * 24 * 7 * 6) {
        if (approx) {
            duration =
                new Date(date.getFullYear(), date.getMonth(), date.getDate()) -
                new Date(this.getFullYear(), this.getMonth(), this.getDate());
        }
        time = formatDuration(duration, approx);
    } else {
        let years = date.getFullYear() - this.getFullYear();
        let months = date.getMonth() - this.getMonth();

        if (isFuture) {
            years = -years;
            months = -months;
        }
        if (months < 0) {
            years -= 1;
            months += 12;
        }
        time = loc(
            '{value1, plural, one {# year} other {# years} =0 {}} {value2, plural, one {# month} other {# months} =0 {}}',
            years,
            months,
        ).trim();
    }

    return isFuture ? loc('In {value1}', time) : loc('{value1} ago', time);
};

/**
    Method: Date#relativeToByDay

    Returns the difference in time between the date given in the sole
    argument (or now if not supplied) and this date, in a human friendly,
    localised form, with the day as the most significant unit. e.g. "today",
    "5 days ago".

    Parameters:
        date   - {Date} Date to compare it to.

    Returns:
        {String} Relative date string.
*/

Date.prototype.relativeToByDay = function (date) {
    if (!date) {
        date = new Date();
    }

    const duration = date - this;
    if (duration < 1000 * 60 * 60 * 24) {
        return loc('Today').toLocaleLowerCase();
    }

    return this.relativeTo(date, true, true);
};

// TODO(cmorgan/modulify): do something about these exports:
// Date#relativeTo, Date.formatDuration
