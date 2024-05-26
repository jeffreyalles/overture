import { Router } from '/overture/application';
import {
    DESTROYED,
    LOADING,
    LocalQuery,
    NON_EXISTENT,
} from '/overture/datastore';

import { Todo } from './Todo.js';
import { TodoList } from './TodoList.js';
import { parseSearch } from './search.js';
import { store } from './store.js';

// Need to initialize our Todos:
store.fetchAll(Todo);

const state = new Router({
    listId: '',
    search: '',

    /* The currently selected TodoList. This is always "Inbox" at the moment,
       but it would be easy to extend the UI to allow you to switch between
       lists.
    */
    list: function () {
        const listId = this.get('listId');
        return store.getRecord(null, TodoList, listId);
    }.property('listId'),

    /* An observable collection of Todo instances that belong to the currently
       selected TodoList and match any search.

       This is a query on our local store, and will automatically update if the
       data in the store changes.
    */
    todos: function () {
        let listId = this.get('listId');
        const searchTree = parseSearch(this.get('search'));

        if (listId) {
            listId = store.getStoreKey(null, TodoList, listId);
        }

        // eslint-disable-next-line no-new-func
        const filter = (data) =>
            data.listId === listId.replace(/"/g, '\\"') &&
            (!searchTree || searchTree.toFunctionMethods()(data));

        return new LocalQuery({
            store,
            Type: Todo,
            sort(a, b) {
                return (
                    a.precedence - b.precedence ||
                    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
                );
            },
            where: filter,
        });
    }.property('listId', 'search'),

    /* Destroy the previous LocalQuery, as it's no longer needed. In the current
       implementation we're not reusing queries, so we should always destroy
       the old ones, otherwise we will leak memory (and time, as each old
       query is kept up to date!)
    */
    cleanupTodos: function (_, __, oldQuery) {
        if (oldQuery) {
            oldQuery.destroy();
        }
    }.observes('todos'),

    /* TODO: Use this property to show a loading animation in the list while
       the initial data is loading (irrelevant with fixtures, but important
       if we had a real backend)
    */
    isLoadingList: false,

    /* If the current TodoList is destroyed, go back to the Inbox TodoList
       (we assume this is always present). If we arrived via a URL, we may have
       tried to load a list id that doesn't actually exist; in this case, the
       same behaviour is applied.
    */
    checkListStatus: function (_, __, ___, status) {
        if (status & (DESTROYED | NON_EXISTENT)) {
            this.set('listId', 'inbox');
        } else {
            this.set('isLoadingList', !!(status & LOADING));
        }
    }.observes('list.status'),

    /* If we switch lists, clear any current search.
     */
    clearSearch: function () {
        this.set('search', '');
    }.observes('listId'),

    /* The Todo currently being edited.
     */
    editTodo: null,

    /* When we finish editing a todo, commit the changes back to the source
       (this automatically records an Undo checkpoint as well).
    */
    commitChanges: function (_, __, oldTodo) {
        if (oldTodo !== null) {
            store.commitChanges();
        }
    }.observes('editTodo'),

    // Page title

    /* The title of our page (as displayed in the browser window/tab).
     */
    title: function () {
        const appName = 'Overture Todo Example';
        const listName = this.getFromPath('list.name');
        return listName ? listName + ' – ' + appName : appName;
    }.property('list'),

    // URL routing (state encoding/decoding)

    /* This is the URL the browser should show. This is dependent on the current
       selected TodoList, but I've decided not to encode any search in the URL.
    */
    encodedState: function () {
        return this.get('listId') + '/';
    }.property('listId'),

    /* Routes are simply a regexp to match against the URL (after any base part)
       and then a function to use to restore the state from that URL.

       The handle fns are called in the context of the App.state object, and
       are supplied with any capture groups in the regexp as arguments 1+.
    */
    routes: [
        {
            url: /^(.*?)\/$/,
            handle(_, queryParams, listId) {
                this.set('listId', listId);
            },
        },
        // Fallback route; if the user comes in via a nonsense URL, just
        // go to our default view.
        {
            url: /.*/,
            handle() {
                /* Don't keep the old state in history */
                this.set('replaceState', true);
                this.set('listId', 'inbox');
            },
        },
    ],
});

export { state };
