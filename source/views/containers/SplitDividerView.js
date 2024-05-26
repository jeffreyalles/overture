import { Class } from '../../core/Core.js';
import { limit } from '../../core/Math.js';
import { Draggable } from '../../drag/Draggable.js';
import { bind, bindTwoWay } from '../../foundation/Binding.js';
import { View } from '../View.js';
import { TOP_LEFT, VERTICAL } from './SplitViewController.js';

/* { property } from */
import '../../foundation/Decorators.js';

/**
    Class: O.SplitDividerView

    Extends: O.View

    Includes: O.Draggable

    An O.SplitDividerView instance represents the divide between two panes
    controllered by an <O.SplitViewController> instance. It can be dragged to
    resize the static pane in the split view.
*/
const SplitDividerView = Class({
    Name: 'SplitDividerView',

    Extends: View,

    Mixin: Draggable,

    init: function (mixin) {
        const controller = mixin.controller;
        SplitDividerView.parent.init.call(
            this,
            controller
                ? {
                      controller,
                      direction: controller.get('direction'),
                      flex: controller.get('flex'),
                      min: bind(controller, 'minStaticPaneLength'),
                      max: bind(controller, 'maxStaticPaneLength'),
                      offset: bindTwoWay(controller, 'staticPaneLength'),
                  }
                : mixin,
        );
    },

    /**
        Property: O.SplitDividerView#className
        Type: String
        Default: 'v-SplitDivider'

        Overrides default in O.View#className.
    */
    className: 'v-SplitDivider',

    /**
        Property: O.SplitDividerView#thickness
        Type: Number
        Default: 10

        How many pixels wide (if vertical split) or tall (if horizontal split)
        the view should be. Note, by default the view is invisible, so this
        really represents the hit area for dragging.
    */
    thickness: 10,

    /**
        Property: O.SplitDividerView#controller
        Type: O.SplitViewController

        The controller for the split view.
    */

    /**
        Property: O.SplitDividerView#direction
        Type: Number

        Bound to the <O.SplitViewController#direction>.
    */

    /**
        Property: O.SplitDividerView#flex
        Type: Number

        Bound to the <O.SplitViewController#flex>.
    */

    /**
        Property: O.SplitDividerView#min
        Type: Number

        Bound to the <O.SplitViewController#minStaticPaneLength>.
    */

    /**
        Property: O.SplitDividerView#max
        Type: Number

        Bound to the <O.SplitViewController#maxStaticPaneLength>.
    */

    /**
        Property: O.SplitDividerView#offset
        Type: Number

        Bound two-way to the <O.SplitViewController#staticPaneLength>. It is
        the distance from the edge of the split view that the split divider
        view should be positioned.
    */

    /**
        Property: O.SplitDividerView#anchor
        Type: String

        The CSS property giving the side the <O.SplitDividerView#offset> is from
        (top/left/bottom/right).
    */
    anchor: function () {
        const flexTL = this.get('flex') === TOP_LEFT;
        const isVertical = this.get('direction') === VERTICAL;
        return isVertical
            ? flexTL
                ? 'right'
                : 'left'
            : flexTL
            ? 'bottom'
            : 'top';
    }.property('flex', 'direction'),

    /**
        Property: O.SplitDividerView#positioning
        Type: String
        Default: 'absolute'

        Overrides default in O.View#positioning
    */
    positioning: 'absolute',

    /**
        Property: O.SplitDividerView#layout
        Type: Object

        Overrides default in O.View#layout to position the view based on the
        direction, anchor, thickness and offset properties.
    */
    layout: function () {
        const thickness = this.get('thickness');
        let styles;
        if (this.get('direction') === VERTICAL) {
            styles = {
                top: 0,
                bottom: 0,
                width: thickness,
            };
        } else {
            styles = {
                left: 0,
                right: 0,
                height: thickness,
            };
        }
        styles[this.get('anchor')] = this.get('offset') - thickness / 2;
        return styles;
    }.property('direction', 'anchor', 'thickness', 'offset'),

    /**
        Method: O.SplitDividerView#dragStarted

        Records the offset at the time the drag starts.
    */
    dragStarted() {
        this.get('controller').set('isResizing', true);
        this._offset = this.get('offset');
        this._dir = this.get('direction') === VERTICAL ? 'x' : 'y';
    },

    /**
        Method: O.SplitDividerView#dragMoved

        Updates the offset property based on the difference between the current
        cursor position and the initial cursor position when the drag started.

        Parameters:
            drag - {O.Drag} The drag instance.
    */
    dragMoved(drag) {
        const dir = this._dir;
        const delta =
            drag.get('cursorPosition')[dir] - drag.get('startPosition')[dir];
        const sign = this.get('flex') === TOP_LEFT ? -1 : 1;

        this.set(
            'offset',
            limit(
                this._offset + sign * delta,
                this.get('min'),
                this.get('max'),
            ),
        );
    },

    dragEnded() {
        this.get('controller').set('isResizing', false);
    },
});

export { SplitDividerView };
