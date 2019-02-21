// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

function escapeRegExp(term) {
    return term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); // $& means the whole matched string
}

// Because \b (word boundary) does not understand unicode chars, we define
// our own way to detect a char which is not part of a word.
const nonWordChar = '[\\s\\x00-\\x26\\x28-\\x29\\x2B-\\x2C\\x2E-\\x2F\\x3A-\\x3F\\x5B-\\x60\\x7B-\\xBF]';
const wordSplitRegExp = new RegExp(`${nonWordChar}+`, 'i');

function wordMatcher(str) {
    return new RegExp(`(?<=^|${nonWordChar})${escapeRegExp(str)}(?=${nonWordChar}|$)`, 'i');
}

function prefixMatcher(str) {
    return new RegExp(`(?<=^|${nonWordChar})${escapeRegExp(str)}`, 'i');
}

function phraseMatcher(str) {
    return new RegExp(escapeRegExp(str), 'i');
}

function isQuoted(str) {
    return str[0] === '"' && str[str.length - 1] === '"';
}

function makeMatchers(str) {
    if (!str || str.length < 3) {
        return [];
    }

    if (isQuoted(str)) {
        return [phraseMatcher(str.slice(1, str.length - 1))];
    }

    const words = str.split(wordSplitRegExp);
    const matchers = [];

    for (const word of words) {
        if (!word || word.length < 3) {
            continue;
        }
        if (word[word.length - 1] === '*') {
            matchers.push(prefixMatcher(word.slice(0, word.length - 1)));
        } else {
            matchers.push(wordMatcher(word));
        }
    }

    return matchers;
}

function sortBy(prop) {
    return (a, b) => {
        if (a[prop] === b[prop]) {
            return 0;
        }
        if (a[prop] > b[prop]) {
            return 1;
        }
        return -1;
    };
}

export function filterPostsWithParams(postsById, params) {
    const result = {
        order: [], // contains ordered post ids
        posts: {}, // contains posts indexed by id
        matches: null,
    };

    const terms = params.terms;
    const matchers = makeMatchers(terms);
    const order = [];

    if (matchers.length > 0) {
        Object.keys(postsById).forEach((id) => {
            const post = postsById[id];
            if (matchers.every((m) => Boolean(post.message.match(m)))) {
                result.posts[id] = post;
                order.push(post);
            }
        });
    }

    order.sort(sortBy('create_at'));

    result.order = order.map((post) => post.id);

    return result;
}
