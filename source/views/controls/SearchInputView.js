import { Class } from '../../core/Core.js';
import { loc } from '../../localisation/i18n.js';
import { when } from '../collections/SwitchView.js';
import { Activatable } from './Activatable.js';
import { ClearSearchButtonView } from './ClearSearchButtonView.js';
import { TextInputView } from './TextInputView.js';

const SearchInputView = Class({
    Name: 'SearchInputView',

    Extends: TextInputView,

    Mixin: [Activatable],

    icon: null,

    inputAttributes: {
        autocapitalize: 'off',
        autocomplete: 'off',
        autocorrect: 'off',
        spellcheck: 'false',
    },

    // Helps password managers know this is not a username input!
    name: 'search',

    baseClassName: 'v-TextInput v-SearchInput',

    draw(layer) {
        const control = this.drawControl();

        this.redrawInputAttributes(layer);
        this.redrawTabIndex(layer);
        this.redrawTooltip(layer);

        return [
            control,
            this.get('icon'),
            when(this, 'value')
                .show([
                    new ClearSearchButtonView({
                        label: loc('Clear search'),
                        target: this,
                        method: 'reset',
                    }),
                ])
                .end(),
        ];
    },

    // Only draw the tooltip on the _domControl
    redrawTooltip() {
        const domControl = this._domControl;
        if (domControl) {
            Activatable.redrawTooltip.call(this, domControl);
        }
    },

    /**
        Method: O.SearchInputView#activate

        Overridden to focus the text view. See <O.Activatable#activate>.
    */
    activate() {
        this.focus();
    },

    reset() {
        this.set('ghost', null).set('value', '').focus();
    },
});

export { SearchInputView };
