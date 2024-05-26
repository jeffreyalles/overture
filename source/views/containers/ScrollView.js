import { Animation } from '../../animation/Animation.js';
import { Class, mixin } from '../../core/Core.js';
import { appendChildren, create as el, setStyle } from '../../dom/Element.js';
import {
    invokeAfterDelay,
    invokeInNextEventLoop,
    invokeInNextFrame,
    queueFn,
} from '../../foundation/RunLoop.js';
import { browser, isIOS, version } from '../../ua/UA.js';
import { RootView } from '../RootView.js';
import { LAYOUT_FILL_PARENT, View } from '../View.js';
import { ViewEventsController } from '../ViewEventsController.js';

/* { property, on, observes, queue } from */
import '../../foundation/Decorators.js';

// ---

/*global document */

class ScrollAnimation extends Animation {
    prepare(coordinates) {
        const object = this.object;
        const startX = (this.startX = object.get('scrollLeft'));
        const startY = (this.startY = object.get('scrollTop'));
        const endX = (this.endX = coordinates.x || 0);
        const endY = (this.endY = coordinates.y || 0);
        const deltaX = (this.deltaX = endX - startX);
        const deltaY = (this.deltaY = endY - startY);

        setStyle(object.get('layer'), 'will-change', 'scroll-position');

        return !!(deltaX || deltaY);
    }

    drawFrame(position) {
        const isRunning = position < 1;
        const object = this.object;
        const x = isRunning ? this.startX + position * this.deltaX : this.endX;
        const y = isRunning ? this.startY + position * this.deltaY : this.endY;
        object._scrollTo(x, y);
        if (!isRunning) {
            setStyle(object.get('layer'), 'will-change', 'auto');
        }
    }
}

ScrollAnimation.prototype.duration = 250;

const supportsScrollEnd = 'onscrollend' in document;

/**
    Class: O.ScrollView

    Extends: O.View

    An O.ScrollView instance is a fixed size container, which can be scrolled if
    its contents overflows the bounds of the view. By default, a scrollbar will
    only be shown for vertical overflow. Set the <O.ScrollView#showScrollbarX>
    property to `true` to show a scrollbar on horizontal overflow as well.
*/
const ScrollView = Class({
    Name: 'ScrollView',

    Extends: View,

    init: function () {
        this._scrollSnap = '';
        this._scrollSnapPause = 0;
        this._scrollSnapResuming = false;
        this._scrollendTimer = null;
        this._scrollendCounter = 0;
        ScrollView.parent.init.apply(this, arguments);
    },

    /**
        Property: O.ScrollView#showScrollbarX
        Type: Boolean
        Default: false

        Show a scrollbar if the content horizontally overflows the bounds of the
        DOM element representing this view?
    */
    showScrollbarX: false,

    /**
        Property: O.ScrollView#showScrollbarY
        Type: Boolean
        Default: true

        Show a scrollbar if the content vertically overflows the bounds of the
        DOM element representing this view?
    */
    showScrollbarY: true,

    /**
        Property: O.ScrollView#positioning
        Type: String
        Default: 'absolute'

        Overrides default in <O.View#positioning>.
    */
    positioning: 'absolute',

    /**
        Property: O.ScrollView#layout
        Type: Object
        Default:
                {
                    top: 0,
                    left: 0,
                    width: '100%',
                    height: '100%'
                }

        Overrides default in <O.View#layout>.
    */
    layout: LAYOUT_FILL_PARENT,

    /**
        Property: O.ScrollView#layerStyles
        Type: Object

        Sets the overflow styles to show the scrollbars.
    */
    layerStyles: function () {
        const styles = View.prototype.layerStyles.call(this);
        styles.overflowX = this.get('showScrollbarX') ? 'auto' : 'hidden';
        styles.overflowY = this.get('showScrollbarY') ? 'auto' : 'hidden';
        if (isIOS && version < 13) {
            styles.WebkitOverflowScrolling = 'touch';
        }
        return styles;
    }.property('layout', 'positioning', 'showScrollbarX', 'showScrollbarY'),

    isFixedDimensions: function () {
        const positioning = this.get('positioning');
        return positioning === 'absolute' || positioning === 'fixed';
    }.property('positioning'),

    /**
        Property: O.ScrollView#keys
        Type: Object
        Default: {}

        Keyboard shortcuts to scroll the view. A map of keyboard shortcut to the
        method name to call on the O.ScrollView instance. These shortcuts will
        automatically be activated/deactivated when the view is added/removed
        to/from the document.

        For example, on the main scroll view for you content, you might set:

            {
                'PageDown': 'scrollPage',
                'PageUp': 'reverseScrollPage',
                'Space': 'scrollPage',
                'Shift-Space': 'reverseScrollPage',
                'ArrowDown': 'scrollLine',
                'ArrowUp': 'reverseScrollLine'
            }
    */
    keys: {},

    didCreateLayer(layer) {
        layer.tabIndex = -1;
    },

    willEnterDocument() {
        ScrollView.parent.willEnterDocument.call(this);
        if (this.get('showScrollbarY')) {
            this.getParent(RootView).addObserverForKey(
                'safeAreaInsetBottom',
                this,
                'redrawSafeArea',
            );
            if (this.get('isFixedDimensions')) {
                const scrollContents =
                    this._scrollContents || this.get('layer');
                scrollContents.appendChild(
                    (this._safeAreaPadding = el(
                        'div.v-Scroll-safeAreaPadding',
                    )),
                );
                this.redrawSafeArea();
            }
        }
        return this.pauseScrollSnap();
    },

    didEnterDocument() {
        const layer = this.get('layer');
        layer.addEventListener('scroll', this, false);
        layer.addEventListener('scrollend', this, false);

        // Add keyboard shortcuts:
        const keys = this.get('keys');
        const shortcuts = ViewEventsController.kbShortcuts;
        for (const key in keys) {
            shortcuts.register(key, this, keys[key]);
        }

        ScrollView.parent.didEnterDocument.call(this);
        return this.resumeScrollSnap();
    },

    willLeaveDocument() {
        // Remove keyboard shortcuts:
        const keys = this.get('keys');
        const shortcuts = ViewEventsController.kbShortcuts;
        for (const key in keys) {
            shortcuts.deregister(key, this, keys[key]);
        }

        const layer = this.get('layer');
        layer.removeEventListener('scroll', this, false);
        layer.removeEventListener('scrollend', this, false);

        return ScrollView.parent.willLeaveDocument.call(this);
    },

    didLeaveDocument() {
        const safeAreaPadding = this._safeAreaPadding;
        if (safeAreaPadding) {
            safeAreaPadding.parentNode.removeChild(safeAreaPadding);
            this._safeAreaPadding = null;
        }
        if (this.get('showScrollbarY')) {
            this.getParent(RootView).removeObserverForKey(
                'safeAreaInsetBottom',
                this,
                'redrawSafeArea',
            );
        }
        return ScrollView.parent.didLeaveDocument.call(this);
    },

    insertView(view, relativeTo, where) {
        const safeAreaPadding = this._safeAreaPadding;
        if (!relativeTo && safeAreaPadding && (!where || where === 'bottom')) {
            relativeTo = safeAreaPadding;
            where = 'before';
        }
        return ScrollView.parent.insertView.call(this, view, relativeTo, where);
    },

    redrawSafeArea() {
        const safeAreaPadding = this._safeAreaPadding;
        if (safeAreaPadding) {
            this._safeAreaPadding.style.height =
                this.getParent(RootView).get('safeAreaInsetBottom') + 'px';
        } else {
            this.didResize();
        }
    },

    // ---

    _restoreScroll: function () {
        // Scroll is reset to 0 in some browsers whenever it is removed from the
        // DOM, so we need to set it to what it should be.
        if (this.get('isInDocument')) {
            const layer = this.get('layer');
            layer.scrollLeft = this.get('scrollLeft');
            layer.scrollTop = this.get('scrollTop');
        }
    }
        .queue('render')
        .observes('isInDocument'),

    /**
        Property: O.ScrollView#scrollAnimation
        Type: O.Animation

        An <O.Animation> object to animate scrolling on this object. Normally
        you will not need to interact with this directly, but just set the
        `withAnimation` argument to `true` when you call O.ScrollView#scrollTo.
        However, if you wish to change the duration or easing method, you can do
        so by setting it on this object.
    */
    scrollAnimation: function () {
        return new ScrollAnimation({
            object: this,
        });
    }.property(),

    /**
        Property: O.ScrollView#isAnimating
        Type: Boolean

        Is the scroll currently animating?
    */
    isAnimating: false,

    willAnimate() {
        this.set('isAnimating', true);
    },

    didAnimate() {
        this.set('isAnimating', false).fire('scrollend');
    },

    /**
        Method: O.ScrollView#scrollToTop

        Scrolls the view to the top
    */
    scrollToTop() {
        return this.scrollTo(0, 0, true);
    },

    /**
        Method: O.ScrollView#scrollToBottom

        Scrolls the view to the bottom
    */
    scrollToBottom() {
        return this.scrollTo(
            0,
            this.get('layer').scrollHeight - this.get('pxHeight'),
            true,
        );
    },

    /**
        Method: O.ScrollView#scrollPage

        Scrolls the view down by the view height - 50px.
    */
    scrollPage() {
        return this.scrollBy(0, this.get('pxHeight') - 50, true);
    },

    /**
        Method: O.ScrollView#reverseScrollPage

        Scrolls the view up by the view height - 50px.
    */
    reverseScrollPage() {
        return this.scrollBy(0, 50 - this.get('pxHeight'), true);
    },

    /**
        Method: O.ScrollView#scrollLine

        Scrolls the view down by 40px.
    */
    scrollLine() {
        return this.scrollBy(0, 40);
    },

    /**
        Method: O.ScrollView#reverseScrollLine

        Scrolls the view up by 40px.
    */
    reverseScrollLine() {
        return this.scrollBy(0, -40);
    },

    /**
        Method: O.ScrollView#scrollBy

        Scroll the view by the given number of pixels (use negative values to
        scroll up/left).

        Parameters:
            x             - {Number} The number of pixels to scroll right.
            y             - {Number} The number of pixels to scroll down.
            withAnimation - {Boolean} (optional) If true, animate the scroll.

        Returns:
            {Boolean} Did the view actually scroll (false if already at end)?
    */
    scrollBy(x, y, withAnimation) {
        const left = this.get('scrollLeft');
        const top = this.get('scrollTop');
        x += left;
        y += top;

        this.scrollTo(x, y, withAnimation);

        return top !== this.get('scrollTop') || left !== this.get('scrollLeft');
    },

    /**
        Method: O.ScrollView#scrollToView

        Scroll the view to show a sub-view in the top left of the view.

        Parameters:
            view          - {View} The sub-view to scroll to.
            offset        - {Object} (optional) If supplied, must contain
                            numerical `x` and `y` properties which give the
                            number of pixels to offset the subview from the top
                            left of the scroll view.
            withAnimation - {Boolean} (optional) If true, animate the scroll.

        Returns:
            {O.ScrollView} Returns self.
    */
    scrollToView(view, offset, withAnimation) {
        const position = view.getPositionRelativeTo(this);
        return this.scrollTo(
            position.left + ((offset && offset.x) || 0),
            position.top + ((offset && offset.y) || 0),
            withAnimation,
        );
    },

    /**
        Method: O.ScrollView#scrollBy

        Scroll the view to a given position, where (0,0) represents the scroll
        view fully .

        Parameters:
            x             - {Number} The number of pixels to set the horizontal
                            scroll-position to.
            y             - {Number} The number of pixels to set the vertical
                            scroll-position to.
            withAnimation - {Boolean} (optional) If true, animate the scroll.

        Returns:
            {O.ScrollView} Returns self.
    */
    scrollTo(x, y, withAnimation) {
        // Can't have negative scroll values.
        // Can't scroll to fractional positions
        x = x < 0 ? 0 : Math.round(x);
        y = y < 0 ? 0 : Math.round(y);

        const isInDocument = this.get('isInDocument');
        const scrollAnimation = this.get('scrollAnimation');
        scrollAnimation.stop();

        if (withAnimation && isInDocument) {
            scrollAnimation.animate({
                x,
                y,
            });
        } else {
            if (isInDocument) {
                this.pauseScrollSnap();
            }
            this.beginPropertyChanges()
                .set('scrollLeft', x)
                .set('scrollTop', y)
                .propertyNeedsRedraw(this, 'scroll')
                .endPropertyChanges()
                .fire('scrollend');
            if (isInDocument) {
                this.resumeScrollSnap();
            }
        }
        return this;
    },

    /**
        Method (private): O.ScrollView#_scrollTo

        Set the new values and immediately redraw. Fast path for animation.
    */
    _scrollTo(x, y) {
        this.set('scrollLeft', x).set('scrollTop', y);
        this.redrawScroll();
    },

    /**
        Method: O.ScrollView#redrawScroll

        Redraws the scroll position in the layer to match the view's state.
    */
    redrawScroll() {
        const layer = this.get('layer');
        const x = this.get('scrollLeft');
        const y = this.get('scrollTop');
        const styles = layer.style;
        // As of at least iOS 15.4 and all predecessors, if iOS is currently
        // doing momentum scrolling and you change the scroll position, it
        // ignores the change and continues applying the precalculated scroll
        // positions. So you end up in the wrong place. It also often fails to
        // redraw correctly so it looks completely broken until you scroll
        // again.
        if (isIOS) {
            styles.overflowX = 'hidden';
            styles.overflowY = 'hidden';
        }
        layer.scrollLeft = x;
        layer.scrollTop = y;
        if (isIOS) {
            styles.overflowX = this.get('showScrollbarX') ? 'auto' : 'hidden';
            styles.overflowY = this.get('showScrollbarY') ? 'auto' : 'hidden';
        }
        // In case we've gone past the end.
        if (x || y) {
            queueFn('after', this.syncBackScroll, this);
        }
    },

    pauseSnapWhileAnimating: function () {
        if (this.get('isAnimating')) {
            this.pauseScrollSnap();
        } else {
            this.resumeScrollSnap();
        }
    }.observes('isAnimating'),

    pauseScrollSnap() {
        if ((this._scrollSnapPause += 1) === 1 && !this._scrollSnapResuming) {
            const layer = this.get('layer');
            const scrollSnapType = layer.style.scrollSnapType;
            layer.style.scrollSnapType = 'none';
            this._scrollSnap = scrollSnapType;
        }
        return this;
    },

    resumeScrollSnap() {
        const scrollSnapType = this._scrollSnap;
        if (
            (this._scrollSnapPause -= 1) === 0 &&
            scrollSnapType !== 'none' &&
            !this._scrollSnapResuming
        ) {
            this._scrollSnapResuming = true;
            invokeInNextFrame(() => {
                invokeInNextEventLoop(() => {
                    this._scrollSnapResuming = false;
                    if (this._scrollSnapPause === 0) {
                        this.get('layer').style.scrollSnapType = scrollSnapType;
                    }
                });
            });
        }
        return this;
    },

    /**
        Method: O.ScrollView#syncBackScroll

        Parameters:
            event - {Event} (optional) The scroll event object.

        Updates the view properties when the layer scrolls.
    */
    syncBackScroll: function (event) {
        if (this._needsRedraw) {
            return;
        }
        const layer = this.get('layer');
        const x = layer.scrollLeft;
        const y = layer.scrollTop;
        this.beginPropertyChanges()
            .set('scrollLeft', x)
            .set('scrollTop', y)
            .endPropertyChanges();
        if (event) {
            event.stopPropagation();
        }
        if (!supportsScrollEnd && !this.get('isAnimating')) {
            this._simulateScrollEnd();
        }
    }.on('scroll'),

    _simulateScrollEnd() {
        const counter = (this._scrollendCounter += 1);
        if (this._scrollendTimer) {
            return;
        }
        this._scrollendTimer = invokeAfterDelay(() => {
            this._scrollendTimer = null;
            if (counter === this._scrollendCounter) {
                this.fire('scrollend');
            } else {
                this._simulateScrollEnd();
            }
        }, 1000);
    },

    // ---

    /**
        Method: O.ScrollView#focus

        Focuses the scrollable element. This will mean default browser shortcuts
        will work for scrolling (e.g. up/down/space etc.).

        Returns:
            {O.ScrollView} Returns self.
    */
    focus() {
        const layer = this.get('layer');
        // Must have a tab index to be able to focus it
        layer.tabIndex = -1;
        layer.focus();
        return this;
    },

    // This is a bit gnarly. When the focus is inside a node inside the scroll
    // view we must not have a tab index, because when we have one the browser
    // will blur the control and focus the scroll view if the user drags on the
    // scrollbar, and the focus should remain in the control.
    //
    // However, when the focus is anywhere else, we do want the tab index, as
    // without it the browser won't focus the scroll view when you click in it,
    // which we want so that native keyboard shortcuts work correctly to scroll.
    _setTabIndex: function (event) {
        const layer = this.get('layer');
        if (event.type === 'blur' || event.target === layer) {
            layer.tabIndex = -1;
        } else {
            layer.removeAttribute('tabIndex');
        }
    }.on('focus', 'blur'),
});

if (isIOS && version < 13) {
    const isOldOrSafari = version < 11 || browser === 'safari';

    mixin(ScrollView.prototype, {
        draw(layer) {
            const isFixedDimensions = this.get('isFixedDimensions');
            let scrollFixerHeight = 1;

            // Render the children.
            const children = ScrollView.parent.draw.call(this, layer);

            // Following platform conventions, we assume a fixed height
            // ScrollView should always scroll, regardless of whether the
            // content is taller than the view, whereas a variable height
            // ScrollView just needs to scroll if the content requires it.
            // Therefore, if it's a fixed height view, we add an extra
            // invisible div permanently 1px below the height, so it always
            // has scrollable content.
            // From iOS 11, if not in Safari, it appears that the view will
            // always be scrollable as long as the content is at longer; you
            // don't need to ensure you are not at the very top
            if (isFixedDimensions && isOldOrSafari) {
                scrollFixerHeight = 2;
                layer.appendChild(el('div', { style: 'height:1px' }));
            }

            // Append the actual children of the scroll view.
            appendChildren(layer, children);

            if (isFixedDimensions) {
                layer.appendChild(
                    el('div', {
                        style:
                            'position:absolute;top:100%;left:0px;' +
                            'width:1px;height:' +
                            scrollFixerHeight +
                            'px;',
                    }),
                );
                this.on('scroll', this, '_setNotAtEnd').addObserverForKey(
                    'isInDocument',
                    this,
                    '_setNotAtEnd',
                );
            }
        },

        _setNotAtEnd: function () {
            if (this.get('isInDocument')) {
                const scrollTop = this.get('scrollTop');
                const scrollLeft = this.get('scrollLeft');
                if (!scrollTop && isOldOrSafari) {
                    this.scrollTo(scrollLeft, 1);
                } else if (
                    scrollTop + this.get('pxHeight') ===
                    this.get('layer').scrollHeight
                ) {
                    this.scrollTo(scrollLeft, scrollTop - 1);
                }
            }
        }.queue('after'),

        preventRootScroll: function (event) {
            if (!this.get('isFixedDimensions')) {
                const layer = this.get('layer');
                if (layer.scrollHeight <= layer.offsetHeight) {
                    event.preventDefault();
                }
            }
        }.on('touchmove'),

        insertView(view, relativeTo, where) {
            const safeAreaPadding = this._safeAreaPadding;
            if (!relativeTo && safeAreaPadding) {
                relativeTo = this.get('layer');
                if (where === 'top') {
                    relativeTo = relativeTo.firstChild;
                    where = 'after';
                } else if (!where || where === 'bottom') {
                    relativeTo = this.get('isFixedDimensions')
                        ? safeAreaPadding.previousSibling
                        : safeAreaPadding;
                    where = 'before';
                }
            }
            return ScrollView.parent.insertView.call(
                this,
                view,
                relativeTo,
                where,
            );
        },
    });
}

export { ScrollView };
