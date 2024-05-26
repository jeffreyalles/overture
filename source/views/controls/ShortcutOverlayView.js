import { formatKeyForPlatform } from '../../application/formatKeyForPlatform.js';
import { Class } from '../../core/Core.js';
import { create as el, getAncestors, getStyle } from '../../dom/Element.js';
import { LAYOUT_FILL_PARENT, View } from '../View.js';

const ShortcutView = Class({
    Name: 'ShortcutView',

    Extends: View,

    key: null,
    forButton: false,

    className: 'v-Shortcut',

    positioning: 'absolute',

    draw() {
        const text = formatKeyForPlatform(this.get('key'));
        return text.length > 1
            ? text
                  .split(/(?![^a-z])\b/i)
                  .map((key) => el('span.v-Shortcut-key', [key]))
            : [text];
    },
});

const ShortcutOverlayView = Class({
    Name: 'ShortcutOverlayView',

    Extends: View,

    className: 'v-ShortcutOverlay',

    shortcuts: {},

    positioning: 'absolute',

    layout: LAYOUT_FILL_PARENT,

    draw() {
        const shortcuts = this.get('shortcuts')._shortcuts;

        const styleCache = new Map();
        const getEffectiveZIndex = function (node) {
            const ancestors = getAncestors(node);
            for (let i = 0; i < ancestors.length; i += 1) {
                const values = styleCache.get(ancestors[i]);
                let position;
                let zIndex;
                if (values) {
                    position = values[0];
                    zIndex = values[1];
                } else {
                    position = getStyle(ancestors[i], 'position');
                    zIndex = getStyle(ancestors[i], 'z-index');
                    styleCache.set(ancestors[i], [position, zIndex]);
                }
                if (position !== 'static' && zIndex !== 'auto') {
                    return parseInt(zIndex, 10);
                }
            }
            return 0;
        };

        return Object.entries(shortcuts).flatMap(([key, value]) => {
            const view = value.last()[0];
            // Check it's actually a view
            if (!(view instanceof View)) {
                return null;
            }

            // Get target(s) and filter nulls
            const target = view.getShortcutTarget(key);
            const targets = (Array.isArray(target) ? target : [target]).filter(
                (_target) => _target !== null,
            );

            return targets.map((_target) => {
                const bbox = _target.getBoundingClientRect();
                const zIndex = getEffectiveZIndex(_target);
                return new ShortcutView({
                    key,
                    target: _target,
                    layout: {
                        left: bbox.right,
                        top: bbox.bottom - bbox.height / 2,
                        zIndex: zIndex + 1,
                    },
                });
            });
        });
    },

    viewNeedsRedraw: function () {
        if (!this.get('isInDocument')) {
            this.propertyNeedsRedraw(this, 'layer');
        }
    }.observes('isInDocument'),
});

export { ShortcutView, ShortcutOverlayView };
