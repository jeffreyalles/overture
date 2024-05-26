import { FRAGMENT_INERT, HTMLDefanger } from './HTMLDefanger.js';

// ---

// HTML Living Standard specifies 5 characters as the ASCII whitespace:
// U+0009 TAB, U+000A LF, U+000C FF, U+000D CR, and U+0020 SPACE.
// Source: https://developer.mozilla.org/en-US/docs/Glossary/whitespace
// The \s character class is too broad and results in stripping nbsp.
const htmlWS = /[\t\n\f\r ]+/g;

const getLastChar = function (stringBuilder) {
    const lastString = stringBuilder.last();
    return lastString ? lastString.charAt(lastString.length - 1) : '';
};

const nodesToText = function (
    stringBuilder,
    nodes,
    listStack,
    quotePrefix,
    inPre,
    markupInline,
) {
    let newQuotePrefix = quotePrefix;
    for (let i = 0, l = nodes.length; i < l; i += 1) {
        const node = nodes[i];
        const children = node.childNodes;
        const tag = node.nodeName;
        let nodeText = '';

        // The contents of these tags always starts on a new line.
        // But ignore if in a list, so that we don't get erroneous new lines
        // when converting <li><div>...</div></li>
        if (!listStack.length && /^(?:P|H[1-6]|DIV|LI)$/.test(tag)) {
            const lastChar = getLastChar(stringBuilder);
            if (lastChar && lastChar !== '\n') {
                stringBuilder.push('\n');
            }
        }

        switch (tag) {
            case 'NOSCRIPT':
            case 'SCRIPT':
            case 'STYLE':
            case '#comment':
                continue;
            case 'I':
            case 'EM':
            case 'B':
            case 'STRONG':
                if (markupInline) {
                    nodeText = '*';
                }
                break;
            case 'U':
                if (markupInline) {
                    nodeText = '_';
                }
                break;
            case 'CODE':
                if (markupInline) {
                    nodeText = '`';
                }
                break;
            case 'UL':
                listStack.push('•');
                break;
            case 'OL':
                listStack.push(1);
                break;
            case 'LI': {
                const end = Math.max(0, listStack.length - 1);
                const marker = listStack[end] || '*';
                // Add indentation of 2 spaces per sub list.
                nodeText = ' '.repeat(end * 2 + 1);
                nodeText += marker;
                if (typeof marker === 'number') {
                    nodeText += '.';
                    listStack[end] = marker + 1;
                }
                nodeText += ' ';
                break;
            }
            case 'TD':
            case 'TH': {
                const lastChar = getLastChar(stringBuilder);
                if (lastChar && lastChar !== '\n') {
                    nodeText = '\t';
                }
                break;
            }
            case 'BLOCKQUOTE':
                newQuotePrefix = quotePrefix ? '>' + quotePrefix : '> ';
                break;
            case 'BR':
                nodeText = '\n';
                break;
            case 'IMG':
                nodeText = node.alt || '';
                if (!inPre) {
                    nodeText = nodeText.replace(htmlWS, ' ');
                }
                break;
            case '#text':
                nodeText = node.data;
                if (!inPre) {
                    nodeText = nodeText.replace(htmlWS, ' ');
                    if (
                        nodeText.charAt(0) === ' ' &&
                        htmlWS.test(getLastChar(stringBuilder))
                    ) {
                        nodeText = nodeText.slice(1);
                    }
                }
                break;
        }
        if (nodeText) {
            const lastChar = getLastChar(stringBuilder);
            // Ignore white space between "real" nodes
            if (inPre || nodeText !== ' ' || !/\s/.test(lastChar)) {
                if (quotePrefix) {
                    if (!lastChar || lastChar === '\n') {
                        stringBuilder.push(quotePrefix);
                    }
                    nodeText = nodeText.replace(/\n(?!$)/g, '\n' + quotePrefix);
                }
                stringBuilder.push(nodeText);
            }
        }
        if (children) {
            nodesToText(
                stringBuilder,
                children,
                listStack,
                newQuotePrefix,
                inPre || tag === 'PRE',
                markupInline,
            );
        }
        switch (tag) {
            case 'A':
                if (markupInline) {
                    const href = node.getAttribute('href');
                    if (href) {
                        let simpleHref = href.replace(/^[a-z]+:(?:\/\/)?/i, '');
                        if (simpleHref.charAt(simpleHref.length - 1) === '/') {
                            simpleHref = simpleHref.slice(0, -1);
                        }
                        if (!node.textContent.includes(simpleHref)) {
                            stringBuilder.push(' <' + href + '>');
                        }
                    }
                }
                break;
            case 'I':
            case 'EM':
            case 'B':
            case 'STRONG':
                if (markupInline) {
                    stringBuilder.push('*');
                }
                break;
            case 'U':
                if (markupInline) {
                    stringBuilder.push('_');
                }
                break;
            case 'CODE':
                if (markupInline) {
                    stringBuilder.push('`');
                }
                break;
            case 'UL':
                listStack.pop();
                break;
            case 'OL':
                listStack.pop();
                break;
            case 'BLOCKQUOTE':
                newQuotePrefix = quotePrefix;
                break;
            case 'DIV':
            case 'LI':
            case 'DD':
            case 'TR':
            case 'TABLE':
            case 'P':
            case 'H1':
            case 'H2':
            case 'H3':
            case 'H4':
            case 'H5':
            case 'H6': {
                const lastChar = getLastChar(stringBuilder);
                if (lastChar !== '\n') {
                    stringBuilder.push('\n');
                }
                // Line break after headings and paragraphs. Special case check
                // for MS Outlook overriding the margin on the <p> since this
                // is so common.
                if (
                    /^H[1-6]$/.test(tag) ||
                    (tag === 'P' &&
                        !/\bMsoNo(?:rmal|Spacing)\b/.test(node.className))
                ) {
                    stringBuilder.push(quotePrefix + '\n');
                }
            }
        }
    }
};

const toPlainText = function (html, markupInline = true, preserveWS = false) {
    const frag = new HTMLDefanger({
        returnType: FRAGMENT_INERT,
    }).defang(html);
    const stringBuilder = [];
    nodesToText(
        stringBuilder,
        frag.childNodes,
        [],
        '',
        preserveWS,
        markupInline,
    );
    // Remove trailing new line from <div></div>.
    const length = stringBuilder.length;
    const lastString = length ? stringBuilder[length - 1] : '';
    const lastChar = lastString && lastString.charAt(lastString.length - 1);
    if (lastChar === '\n') {
        stringBuilder[length - 1] = lastString.slice(0, -1);
    }
    // Replace nbsp with regular space
    return stringBuilder.join('').replace(/\u00a0/g, ' ');
};

// ---

export { toPlainText };
