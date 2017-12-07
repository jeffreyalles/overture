/**
    Namespace: O.DOMEvent

    O.DOMEvent contains functions for use with DOM event objects
*/

/**
    Property: O.DOMEvent.keys
    Type: Object

    Maps the names of special keys to their key code.
*/
const keys = {
    8: 'Backspace',
    9: 'Tab',
    13: 'Enter',
    16: 'Shift',
    17: 'Control',
    18: 'Alt',
    20: 'CapsLock',
    27: 'Escape',
    32: 'Space',
    33: 'PageUp',
    34: 'PageDown',
    35: 'End',
    36: 'Home',
    37: 'ArrowLeft',
    38: 'ArrowUp',
    39: 'ArrowRight',
    40: 'ArrowDown',
    46: 'Delete',
    144: 'NumLock',
};

/**
    Function: O.DOMEvent.lookupKey

    Determines which key was pressed to generate the event supplied as an
    argument.

    Parameters:
        event       - {KeyEvent} The W3C DOM event object.
        noModifiers - Unless true, Alt-/Ctrl-/Meta-/Shift- will be prepended
                      to the returned value if the respective keys are held
                      down. They will always be in alphabetical order, e.g.
                      If the user pressed 'g' whilst holding down Shift and
                      Alt, the return value would be 'Alt-Shift-g'.

    Returns:
        {String} The key pressed (in lowercase if a letter).
*/
const lookupKey = function ( event, noModifiers ) {
    const isKeyPress = ( event.type === 'keypress' );
    // Newer browser api
    let key = event.key;
    if ( !key ) {
        // See http://unixpapa.com/js/key.html. Short summary:
        // event.keyCode || event.which gives the ASCII code for any normal
        // keypress on all browsers. However, if event.which === 0 then it was a
        // special key and so it should be looked up in the table of function
        // keys. Anything from code 32 downwards must also be a special char.
        const code = event.keyCode || event.which;
        const preferAsci = isKeyPress && code > 32 &&
                event.which !== 0 && event.charCode !== 0;
        const str = String.fromCharCode( code ).toLowerCase();
        key = ( !preferAsci && keys[ code ] ) || str;

        // Function keys
        if ( !preferAsci && 111 < code && code < 124 ) {
            key = 'F' + ( code - 111 );
        }
    } else if ( key === ' ' ) {
        key = 'Space';
    }

    // Append modifiers (use alphabetical order)
    let modifiers = '';
    if ( !noModifiers ) {
        // Different keyboard layouts may require Shift/Alt for non A-Z
        // keys, so we only add meta and ctrl modifiers.
        const altAndShift = !isKeyPress || ( /[a-z]/.test( key ) );
        if ( event.altKey && altAndShift ) {
            modifiers += 'Alt-';
        }
        if ( event.ctrlKey ) {
            modifiers += 'Ctrl-';
        }
        if ( event.metaKey ) {
            modifiers += 'Meta-';
        }
        if ( event.shiftKey && altAndShift ) {
            modifiers += 'Shift-';
        }
    }

    return modifiers + key;
};

/**
    Function: O.DOMEvent.isClickModified

    Determines if a secondary mouse button was pressed, or a modifier key
    was held down while the mouse was clicked.

    Parameters:
        event - {MouseEvent} The W3C DOM click event object.

    Returns:
        {Boolean} Was a secondary button clicked or modifier held down?
*/
const isClickModified = function ( event ) {
    return !!event.button ||
        event.altKey || event.ctrlKey || event.metaKey || event.shiftKey;
};

export { keys, lookupKey, isClickModified };
