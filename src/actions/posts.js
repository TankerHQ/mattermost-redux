// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import {batchActions} from 'redux-batched-actions';

import {Client4} from 'client';
import {General, Preferences, Posts, WebsocketEvents} from 'constants';
import {PostTypes, FileTypes, IntegrationTypes} from 'action_types';

import {getCurrentChannelId, getMyChannelMember as getMyChannelMemberSelector} from 'selectors/entities/channels';
import {getCustomEmojisByName as selectCustomEmojisByName} from 'selectors/entities/emojis';
import {getConfig} from 'selectors/entities/general';
import * as Selectors from 'selectors/entities/posts';
import {getCurrentUserId, getUsersByUsername} from 'selectors/entities/users';

import {getUserIdFromChannelName} from 'utils/channel_utils';
import {parseNeededCustomEmojisFromText} from 'utils/emoji_utils';
import {isFromWebhook, isSystemMessage, shouldIgnorePost} from 'utils/post_utils';

import {getMyChannelMember, markChannelAsUnread, markChannelAsRead, markChannelAsViewed} from './channels';
import {systemEmojis, getCustomEmojiByName, getCustomEmojisByName} from './emojis';
import {requestData, forceLogoutIfNecessary} from './helpers';
import {logError} from './errors';

import {
    deletePreferences,
    makeDirectChannelVisibleIfNecessary,
    makeGroupMessageVisibleIfNecessary,
    savePreferences,
} from './preferences';
import {getProfilesByIds, getProfilesByUsernames, getStatusesByIds} from './users';
import {encodeMessage, decodePosts, decodePost} from './tanker';

export function getPost(postId) {
    return async (dispatch, getState) => {
        let post;

        try {
            post = await Client4.getPost(postId);
            getProfilesAndStatusesForPosts([post], dispatch, getState);
        } catch (error) {
            forceLogoutIfNecessary(error, dispatch, getState);
            dispatch(batchActions([
                {type: PostTypes.GET_POSTS_FAILURE, error},
                logError(error),
            ]), getState);
            return {error};
        }

        const clearPost = decodePost(post);
        dispatch(batchActions([
            {
                type: PostTypes.RECEIVED_POST,
                data: clearPost,
            },
            {
                type: PostTypes.GET_POSTS_SUCCESS,
            },
        ]));

        return {data: clearPost};
    };
}

export function createPost(post, files = []) {
    return async (dispatch, getState) => {
        const state = getState();
        const currentUserId = state.entities.users.currentUserId;

        const timestamp = Date.now();
        const pendingPostId = post.pending_post_id || `${currentUserId}:${timestamp}`;

        if (Selectors.isPostIdSending(state, pendingPostId)) {
            return {data: true};
        }

        let newPost = {
            ...post,
            pending_post_id: pendingPostId,
            create_at: timestamp,
            update_at: timestamp,
        };

        // We are retrying a pending post that had files
        if (newPost.file_ids && !files.length) {
            files = newPost.file_ids.map((id) => state.entities.files.files[id]); // eslint-disable-line
        }

        if (files.length) {
            const fileIds = files.map((file) => file.id);

            newPost = {
                ...newPost,
                file_ids: fileIds,
            };

            dispatch({
                type: FileTypes.RECEIVED_FILES_FOR_POST,
                postId: pendingPostId,
                data: files,
            });
        }

        dispatch({
            type: PostTypes.RECEIVED_NEW_POST,
            data: {
                id: pendingPostId,
                ...newPost,
            },
            meta: {
                offline: {
                    effect: async () => {
                        const encryptedMessage = await encodeMessage(dispatch, getState, newPost.message, newPost.channel_id);
                        return Client4.createPost({...newPost, message: encryptedMessage, props: {encrypted: true}, create_at: 0});
                    },
                    commit: (success, payload) => {
                        // Use RECEIVED_POSTS to clear pending and sending posts
                        const actions = [{
                            type: PostTypes.RECEIVED_POSTS,
                            data: {
                                order: [],
                                posts: {
                                    [payload.id]: {...payload, message: newPost.message},
                                },
                            },
                            channelId: payload.channel_id,
                        }];

                        if (files) {
                            actions.push({
                                type: FileTypes.RECEIVED_FILES_FOR_POST,
                                postId: payload.id,
                                data: files,
                            });
                        }

                        actions.push({
                            type: PostTypes.CREATE_POST_SUCCESS,
                        });

                        dispatch(batchActions(actions));
                    },
                    maxRetry: 0,
                    offlineRollback: true,
                    rollback: (success, error) => {
                        const data = {
                            ...newPost,
                            id: pendingPostId,
                            failed: true,
                        };

                        const actions = [
                            {type: PostTypes.CREATE_POST_FAILURE, error},
                        ];

                        // If the failure was because: the root post was deleted or
                        // TownSquareIsReadOnly=true then remove the post
                        if (error.server_error_id === 'api.post.create_post.root_id.app_error' ||
                            error.server_error_id === 'api.post.create_post.town_square_read_only'
                        ) {
                            dispatch(removePost(data));
                        } else {
                            actions.push({
                                type: PostTypes.RECEIVED_POST,
                                data,
                            });
                        }

                        dispatch(batchActions(actions));
                    },
                },
            },
        });

        return {data: true};
    };
}

export function createPostImmediately(post, files = []) {
    return async (dispatch, getState) => {
        const state = getState();
        const currentUserId = state.entities.users.currentUserId;

        const timestamp = Date.now();
        const pendingPostId = `${currentUserId}:${timestamp}`;

        let newPost = {
            ...post,
            pending_post_id: pendingPostId,
            create_at: timestamp,
            update_at: timestamp,
        };

        const encryptedMessage = await encodeMessage(dispatch, getState, newPost.message, newPost.channel_id);

        if (files.length) {
            const fileIds = files.map((file) => file.id);

            newPost = {
                ...newPost,
                file_ids: fileIds,
            };

            dispatch({
                type: FileTypes.RECEIVED_FILES_FOR_POST,
                postId: pendingPostId,
                data: files,
            });
        }

        dispatch({
            type: PostTypes.RECEIVED_NEW_POST,
            data: {
                id: pendingPostId,
                ...newPost,
            },
        });

        try {
            const created = await Client4.createPost({...newPost, message: encryptedMessage, props: {encrypted: true}, create_at: 0});
            newPost.id = created.id;
        } catch (error) {
            forceLogoutIfNecessary(error, dispatch, getState);
            dispatch(batchActions([
                {type: PostTypes.CREATE_POST_FAILURE, error},
                {type: PostTypes.REMOVE_PENDING_POST, data: {id: pendingPostId, channel_id: newPost.channel_id}},
                logError(error),
            ]), getState);
            return {error};
        }

        const actions = [{
            type: PostTypes.RECEIVED_POSTS,
            data: {
                order: [],
                posts: {
                    [newPost.id]: newPost,
                },
            },
            channelId: newPost.channel_id,
        }];

        if (files) {
            actions.push({
                type: FileTypes.RECEIVED_FILES_FOR_POST,
                postId: newPost.id,
                data: files,
            });
        }

        actions.push({
            type: PostTypes.CREATE_POST_SUCCESS,
        });

        dispatch(batchActions(actions), getState);

        return {data: newPost};
    };
}

export function resetCreatePostRequest() {
    return {type: PostTypes.CREATE_POST_RESET_REQUEST};
}

export function deletePost(post) {
    return async (dispatch, getState) => {
        const state = getState();
        const delPost = {...post};
        if (delPost.type === Posts.POST_TYPES.COMBINED_USER_ACTIVITY) {
            delPost.system_post_ids.forEach((systemPostId) => {
                const systemPost = Selectors.getPost(state, systemPostId);
                if (systemPost) {
                    dispatch(deletePost(systemPost));
                }
            });

            dispatch({
                type: PostTypes.POST_DELETED,
                data: delPost,
            });
        } else {
            dispatch({
                type: PostTypes.POST_DELETED,
                data: delPost,
                meta: {
                    offline: {
                        effect: () => Client4.deletePost(post.id),
                        commit: {type: PostTypes.POST_DELETED},
                        rollback: {
                            type: PostTypes.RECEIVED_POST,
                            data: delPost,
                        },
                    },
                },
            });
        }

        return {data: true};
    };
}

export function editPost(post) {
    return async (dispatch, getState) => {
        dispatch(requestData(PostTypes.EDIT_POST_REQUEST), getState);

        const encryptedMessage = await encodeMessage(dispatch, getState, post.message, post.channel_id);

        let data = null;
        try {
            data = await Client4.patchPost({...post, message: encryptedMessage, props: {encrypted: true}});
            data.message = post.message;
        } catch (error) {
            forceLogoutIfNecessary(error, dispatch, getState);
            const actions = [logError(error)];
            actions.push({type: PostTypes.EDIT_POST_FAILURE, error});
            dispatch(batchActions(actions));
            return {error};
        }

        const actions = [{type: PostTypes.RECEIVED_POST, data}];
        actions.push({type: PostTypes.EDIT_POST_SUCCESS, data});
        dispatch(batchActions(actions));

        return {data};
    };
}

export function decryptPost(post) {
    return async (dispatch, getState) => {
        return decodePost(getState, post);
    };
}

export function pinPost(postId) {
    return async (dispatch, getState) => {
        dispatch({type: PostTypes.EDIT_POST_REQUEST}, getState);
        let posts;

        try {
            posts = await Client4.pinPost(postId);
        } catch (error) {
            forceLogoutIfNecessary(error, dispatch, getState);
            dispatch(batchActions([
                {type: PostTypes.EDIT_POST_FAILURE, error},
                logError(error),
            ]), getState);
            return {error};
        }

        const actions = [
            {
                type: PostTypes.EDIT_POST_SUCCESS,
            },
        ];

        const post = Selectors.getPost(getState(), postId);
        if (post) {
            actions.push(
                {
                    type: PostTypes.RECEIVED_POST,
                    data: {...post, is_pinned: true},
                }
            );
        }

        dispatch(batchActions(actions), getState);

        return {data: posts};
    };
}

export function unpinPost(postId) {
    return async (dispatch, getState) => {
        dispatch({type: PostTypes.EDIT_POST_REQUEST}, getState);
        let posts;

        try {
            posts = await Client4.unpinPost(postId);
        } catch (error) {
            forceLogoutIfNecessary(error, dispatch, getState);
            dispatch(batchActions([
                {type: PostTypes.EDIT_POST_FAILURE, error},
                logError(error),
            ]), getState);
            return {error};
        }

        const actions = [
            {
                type: PostTypes.EDIT_POST_SUCCESS,
            },
        ];

        const post = Selectors.getPost(getState(), postId);
        if (post) {
            actions.push(
                {
                    type: PostTypes.RECEIVED_POST,
                    data: {...post, is_pinned: false},
                }
            );
        }

        dispatch(batchActions(actions), getState);

        return {data: posts};
    };
}

export function addReaction(postId, emojiName) {
    return async (dispatch, getState) => {
        const currentUserId = getState().entities.users.currentUserId;

        let reaction;
        try {
            reaction = await Client4.addReaction(currentUserId, postId, emojiName);
        } catch (error) {
            forceLogoutIfNecessary(error, dispatch, getState);
            dispatch(logError(error));
            return {error};
        }

        dispatch({
            type: PostTypes.RECEIVED_REACTION,
            data: reaction,
        });

        return {data: true};
    };
}

export function removeReaction(postId, emojiName) {
    return async (dispatch, getState) => {
        const currentUserId = getState().entities.users.currentUserId;

        try {
            await Client4.removeReaction(currentUserId, postId, emojiName);
        } catch (error) {
            forceLogoutIfNecessary(error, dispatch, getState);
            dispatch(logError(error));
            return {error};
        }

        dispatch({
            type: PostTypes.REACTION_DELETED,
            data: {user_id: currentUserId, post_id: postId, emoji_name: emojiName},
        });

        return {data: true};
    };
}

export function getCustomEmojiForReaction(name) {
    return async (dispatch, getState) => {
        const nonExistentEmoji = getState().entities.emojis.nonExistentEmoji;
        const customEmojisByName = selectCustomEmojisByName(getState());

        if (systemEmojis.has(name)) {
            return {data: true};
        }

        if (nonExistentEmoji.has(name)) {
            return {data: true};
        }

        if (customEmojisByName.has(name)) {
            return {data: true};
        }

        return dispatch(getCustomEmojiByName(name));
    };
}

export function getReactionsForPost(postId) {
    return async (dispatch, getState) => {
        let reactions;
        try {
            reactions = await Client4.getReactionsForPost(postId);
        } catch (error) {
            forceLogoutIfNecessary(error, dispatch, getState);
            dispatch(logError(error));
            return {error};
        }

        if (reactions && reactions.length > 0) {
            const nonExistentEmoji = getState().entities.emojis.nonExistentEmoji;
            const customEmojisByName = selectCustomEmojisByName(getState());
            const emojisToLoad = new Set();

            reactions.forEach((r) => {
                const name = r.emoji_name;

                if (systemEmojis.has(name)) {
                    // It's a system emoji, go the next match
                    return;
                }

                if (nonExistentEmoji.has(name)) {
                    // We've previously confirmed this is not a custom emoji
                    return;
                }

                if (customEmojisByName.has(name)) {
                    // We have the emoji, go to the next match
                    return;
                }

                emojisToLoad.add(name);
            });

            dispatch(getCustomEmojisByName(Array.from(emojisToLoad)));
        }

        dispatch(batchActions([
            {
                type: PostTypes.RECEIVED_REACTIONS,
                data: reactions,
                postId,
            },
        ]));

        return reactions;
    };
}

export function flagPost(postId) {
    return async (dispatch, getState) => {
        const {currentUserId} = getState().entities.users;
        const preference = {
            user_id: currentUserId,
            category: Preferences.CATEGORY_FLAGGED_POST,
            name: postId,
            value: 'true',
        };

        Client4.trackEvent('action', 'action_posts_flag');

        return savePreferences(currentUserId, [preference])(dispatch, getState);
    };
}

export function getPostThread(postId, skipAddToChannel = true) {
    return async (dispatch, getState) => {
        dispatch({type: PostTypes.GET_POST_THREAD_REQUEST}, getState);

        let posts;
        try {
            posts = await Client4.getPostThread(postId);
            getProfilesAndStatusesForPosts(posts.posts, dispatch, getState);
        } catch (error) {
            forceLogoutIfNecessary(error, dispatch, getState);
            dispatch(batchActions([
                {type: PostTypes.GET_POST_THREAD_FAILURE, error},
                logError(error),
            ]), getState);
            return {error};
        }

        const post = posts.posts[postId];

        const clearPosts = await decodePosts(getState, posts);
        dispatch(batchActions([
            {
                type: PostTypes.RECEIVED_POSTS,
                data: clearPosts,
                channelId: post.channel_id,
                skipAddToChannel,
            },
            {
                type: PostTypes.GET_POST_THREAD_SUCCESS,
            },
        ], 'BATCH_GET_POST_THREAD'), getState);

        return {data: clearPosts};
    };
}

export function getPostThreadWithRetry(postId) {
    return async (dispatch, getState) => {
        dispatch({
            type: PostTypes.GET_POST_THREAD_REQUEST,
        });

        dispatch({
            type: PostTypes.GET_POST_THREAD_WITH_RETRY_ATTEMPT,
            data: {},
            meta: {
                offline: {
                    effect: async () => {
                        const payload = await Client4.getPostThread(postId);
                        return decodePosts(getState, payload);
                    },
                    commit: (success, payload) => {
                        const {posts} = payload;
                        const post = posts[postId];
                        getProfilesAndStatusesForPosts(posts, dispatch, getState);

                        dispatch(batchActions([
                            {
                                type: PostTypes.RECEIVED_POSTS,
                                data: payload,
                                channelId: post.channel_id,
                                skipAddToChannel: true,
                            },
                            {
                                type: PostTypes.GET_POST_THREAD_SUCCESS,
                            },
                        ]), getState);
                    },
                    maxRetry: 2,
                    cancel: true,
                    onRetryScheduled: () => {
                        dispatch({
                            type: PostTypes.GET_POST_THREAD_WITH_RETRY_ATTEMPT,
                        });
                    },
                    rollback: (success, error) => {
                        forceLogoutIfNecessary(error, dispatch, getState);
                        dispatch(batchActions([
                            {type: PostTypes.GET_POST_THREAD_FAILURE, error},
                            logError(error),
                        ]), getState);
                    },
                },
            },
        });

        return {data: true};
    };
}

export function getPosts(channelId, page = 0, perPage = Posts.POST_CHUNK_SIZE) {
    return async (dispatch, getState) => {
        let posts;

        try {
            posts = await Client4.getPosts(channelId, page, perPage);
            getProfilesAndStatusesForPosts(posts.posts, dispatch, getState);
        } catch (error) {
            forceLogoutIfNecessary(error, dispatch, getState);
            dispatch(logError(error));
            return {error};
        }

        const clearPosts = await decodePosts(getState, posts);
        dispatch({
            type: PostTypes.RECEIVED_POSTS,
            data: clearPosts,
            channelId,
        });

        return {data: clearPosts};
    };
}

export function getPostsWithRetry(channelId, page = 0, perPage = Posts.POST_CHUNK_SIZE) {
    return async (dispatch, getState) => {
        dispatch({
            type: PostTypes.GET_POSTS_WITH_RETRY_ATTEMPT,
            data: {},
            meta: {
                offline: {
                    effect: async () => {
                        const payload = await Client4.getPosts(channelId, page, perPage);
                        return decodePosts(getState, payload);
                    },
                    commit: (success, payload) => {
                        const {posts} = payload;
                        getProfilesAndStatusesForPosts(posts, dispatch, getState);
                        dispatch(batchActions([
                            {
                                type: PostTypes.RECEIVED_POSTS,
                                data: payload,
                                channelId,
                            },
                            {
                                type: PostTypes.GET_POSTS_SUCCESS,
                            },
                        ]));
                    },
                    maxRetry: 2,
                    cancel: true,
                    onRetryScheduled: () => {
                        dispatch({
                            type: PostTypes.GET_POSTS_WITH_RETRY_ATTEMPT,
                        });
                    },
                    rollback: (success, error) => {
                        forceLogoutIfNecessary(error, dispatch, getState);
                        dispatch(logError(error));
                    },
                },
            },
        });

        return {data: true};
    };
}

export function getPostsSince(channelId, since) {
    return async (dispatch, getState) => {
        let posts;
        try {
            posts = await Client4.getPostsSince(channelId, since);
            getProfilesAndStatusesForPosts(posts.posts, dispatch, getState);
        } catch (error) {
            forceLogoutIfNecessary(error, dispatch, getState);
            dispatch(logError(error));
            return {error};
        }

        const clearPosts = await decodePosts(getState, posts);
        dispatch(batchActions([
            {
                type: PostTypes.RECEIVED_POSTS,
                data: clearPosts,
                channelId,
            },
            {
                type: PostTypes.GET_POSTS_SINCE_SUCCESS,
            },
        ]));

        return {data: clearPosts};
    };
}

export function getPostsSinceWithRetry(channelId, since) {
    return async (dispatch, getState) => {
        dispatch({
            type: PostTypes.GET_POSTS_SINCE_WITH_RETRY_ATTEMPT,
            data: {},
            meta: {
                offline: {
                    effect: async () => {
                        const payload = await Client4.getPostsSince(channelId, since);
                        return decodePosts(getState, payload);
                    },
                    commit: (success, payload) => {
                        const {posts} = payload;
                        getProfilesAndStatusesForPosts(posts, dispatch, getState);

                        dispatch(batchActions([
                            {
                                type: PostTypes.RECEIVED_POSTS,
                                data: payload,
                                channelId,
                            },
                            {
                                type: PostTypes.GET_POSTS_SINCE_SUCCESS,
                            },
                        ]));
                    },
                    maxRetry: 2,
                    cancel: true,
                    onRetryScheduled: () => {
                        dispatch({
                            type: PostTypes.GET_POSTS_SINCE_WITH_RETRY_ATTEMPT,
                        });
                    },
                    rollback: (success, error) => {
                        forceLogoutIfNecessary(error, dispatch, getState);
                        dispatch(logError(error));
                    },
                },
            },
        });

        return {data: true};
    };
}

export function getPostsBefore(channelId, postId, page = 0, perPage = Posts.POST_CHUNK_SIZE) {
    return async (dispatch, getState) => {
        let posts;
        try {
            posts = await Client4.getPostsBefore(channelId, postId, page, perPage);
            getProfilesAndStatusesForPosts(posts.posts, dispatch, getState);
        } catch (error) {
            forceLogoutIfNecessary(error, dispatch, getState);
            dispatch(logError(error));
            return {error};
        }

        const clearPosts = await decodePosts(getState, posts);
        dispatch({
            type: PostTypes.RECEIVED_POSTS,
            data: clearPosts,
            channelId,
        });

        return {data: clearPosts};
    };
}

export function getPostsBeforeWithRetry(channelId, postId, page = 0, perPage = Posts.POST_CHUNK_SIZE) {
    return async (dispatch, getState) => {
        dispatch({
            type: PostTypes.GET_POSTS_BEFORE_WITH_RETRY_ATTEMPT,
            data: {},
            meta: {
                offline: {
                    effect: async () => {
                        const payload = await Client4.getPostsBefore(channelId, postId, page, perPage);
                        return decodePosts(getState, payload);
                    },
                    commit: (success, payload) => {
                        const {posts} = payload;
                        getProfilesAndStatusesForPosts(posts, dispatch, getState);

                        dispatch({
                            type: PostTypes.RECEIVED_POSTS,
                            data: payload,
                            channelId,
                        });
                    },
                    maxRetry: 2,
                    cancel: true,
                    onRetryScheduled: () => {
                        dispatch({
                            type: PostTypes.GET_POSTS_BEFORE_WITH_RETRY_ATTEMPT,
                        });
                    },
                    rollback: (success, error) => {
                        forceLogoutIfNecessary(error, dispatch, getState);
                        dispatch(logError(error));
                    },
                },
            },
        });

        return {data: true};
    };
}

export function getPostsAfter(channelId, postId, page = 0, perPage = Posts.POST_CHUNK_SIZE) {
    return async (dispatch, getState) => {
        let posts;
        try {
            posts = await Client4.getPostsAfter(channelId, postId, page, perPage);
            getProfilesAndStatusesForPosts(posts.posts, dispatch, getState);
        } catch (error) {
            forceLogoutIfNecessary(error, dispatch, getState);
            dispatch(getState);
            return {error};
        }

        const clearPosts = await decodePosts(getState, posts);
        dispatch({
            type: PostTypes.RECEIVED_POSTS,
            data: clearPosts,
            channelId,
        });

        return {data: clearPosts};
    };
}

export function getPostsAfterWithRetry(channelId, postId, page = 0, perPage = Posts.POST_CHUNK_SIZE) {
    return async (dispatch, getState) => {
        dispatch({
            type: PostTypes.GET_POSTS_AFTER_WITH_RETRY_ATTEMPT,
            data: {},
            meta: {
                offline: {
                    effect: async () => {
                        const payload = await Client4.getPostsAfter(channelId, postId, page, perPage);
                        return decodePosts(getState, payload);
                    },
                    commit: (success, payload) => {
                        const {posts} = payload;
                        getProfilesAndStatusesForPosts(posts, dispatch, getState);

                        dispatch({
                            type: PostTypes.RECEIVED_POSTS,
                            data: payload,
                            channelId,
                        });
                    },
                    maxRetry: 2,
                    cancel: true,
                    onRetryScheduled: () => {
                        dispatch({
                            type: PostTypes.GET_POSTS_AFTER_WITH_RETRY_ATTEMPT,
                        });
                    },
                    rollback: (success, error) => {
                        forceLogoutIfNecessary(error, dispatch, getState);
                        dispatch(logError(error));
                    },
                },
            },
        });

        return {data: true};
    };
}

// Note that getProfilesAndStatusesForPosts can take either an array of posts or a map of ids to posts
export function getProfilesAndStatusesForPosts(postsArrayOrMap, dispatch, getState) {
    if (!postsArrayOrMap) {
        // Some API methods return {error} for no results
        return Promise.resolve();
    }

    const posts = Object.values(postsArrayOrMap);

    if (posts.length === 0) {
        return Promise.resolve();
    }

    const state = getState();
    const {currentUserId, profiles, statuses} = state.entities.users;

    // Statuses and profiles of the users who made the posts
    const userIdsToLoad = new Set();
    const statusesToLoad = new Set();

    Object.values(posts).forEach((post) => {
        const userId = post.user_id;

        if (!statuses[userId]) {
            statusesToLoad.add(userId);
        }

        if (userId === currentUserId) {
            return;
        }

        if (!profiles[userId]) {
            userIdsToLoad.add(userId);
        }
    });

    const promises = [];
    if (userIdsToLoad.size > 0) {
        promises.push(getProfilesByIds(Array.from(userIdsToLoad))(dispatch, getState));
    }

    if (statusesToLoad.size > 0) {
        promises.push(getStatusesByIds(Array.from(statusesToLoad))(dispatch, getState));
    }

    // Profiles of users mentioned in the posts
    const usernamesToLoad = getNeededAtMentionedUsernames(state, posts);

    if (usernamesToLoad.size > 0) {
        promises.push(getProfilesByUsernames(Array.from(usernamesToLoad))(dispatch, getState));
    }

    // Emojis used in the posts
    const emojisToLoad = getNeededCustomEmojis(state, posts);

    if (emojisToLoad && emojisToLoad.size > 0) {
        promises.push(getCustomEmojisByName(Array.from(emojisToLoad))(dispatch, getState));
    }

    return Promise.all(promises);
}

export function getNeededAtMentionedUsernames(state, posts) {
    let usersByUsername; // Populate this lazily since it's relatively expensive

    const usernamesToLoad = new Set();

    posts.forEach((post) => {
        if (!post.message.includes('@')) {
            return;
        }

        if (!usersByUsername) {
            usersByUsername = getUsersByUsername(state);
        }

        const pattern = /\B@(([a-z0-9_.-]*[a-z0-9_])[.-]*)/gi;

        let match;
        while ((match = pattern.exec(post.message)) !== null) {
            // match[1] is the matched mention including trailing punctuation
            // match[2] is the matched mention without trailing punctuation
            if (General.SPECIAL_MENTIONS.indexOf(match[2]) !== -1) {
                continue;
            }

            if (usersByUsername[match[1]] || usersByUsername[match[2]]) {
                // We have the user, go to the next match
                continue;
            }

            // If there's no trailing punctuation, this will only add 1 item to the set
            usernamesToLoad.add(match[1]);
            usernamesToLoad.add(match[2]);
        }
    });

    return usernamesToLoad;
}

function buildPostAttachmentText(attachments) {
    let attachmentText = '';

    attachments.forEach((a) => {
        if (a.fields && a.fields.length) {
            a.fields.forEach((f) => {
                attachmentText += ' ' + (f.value || '');
            });
        }

        if (a.pretext) {
            attachmentText += ' ' + a.pretext;
        }

        if (a.text) {
            attachmentText += ' ' + a.text;
        }
    });

    return attachmentText;
}

export function getNeededCustomEmojis(state, posts) {
    if (getConfig(state).EnableCustomEmoji !== 'true') {
        return new Set();
    }

    // If post metadata is supported, custom emojis will have been provided as part of that
    if (posts[0].metadata) {
        return new Set();
    }

    let customEmojisToLoad = new Set();

    let customEmojisByName; // Populate this lazily since it's relatively expensive
    const nonExistentEmoji = state.entities.emojis.nonExistentEmoji;

    posts.forEach((post) => {
        if (post.message.includes(':')) {
            if (!customEmojisByName) {
                customEmojisByName = selectCustomEmojisByName(state);
            }

            const emojisFromPost = parseNeededCustomEmojisFromText(post.message, systemEmojis, customEmojisByName, nonExistentEmoji);

            if (emojisFromPost.size > 0) {
                customEmojisToLoad = new Set([...customEmojisToLoad, ...emojisFromPost]);
            }
        }

        const props = post.props;
        if (props && props.attachments && props.attachments.length) {
            if (!customEmojisByName) {
                customEmojisByName = selectCustomEmojisByName(state);
            }

            const attachmentText = buildPostAttachmentText(props.attachments);

            if (attachmentText) {
                const emojisFromAttachment = parseNeededCustomEmojisFromText(attachmentText, systemEmojis, customEmojisByName, nonExistentEmoji);

                if (emojisFromAttachment.size > 0) {
                    customEmojisToLoad = new Set([...customEmojisToLoad, ...emojisFromAttachment]);
                }
            }
        }
    });

    return customEmojisToLoad;
}

export function removePost(post) {
    return async (dispatch, getState) => {
        dispatch({
            type: PostTypes.REMOVE_POST,
            data: {...post},
        }, getState);

        return {data: true};
    };
}

export function selectPost(postId) {
    return async (dispatch, getState) => {
        dispatch({
            type: PostTypes.RECEIVED_POST_SELECTED,
            data: postId,
        }, getState);

        return {data: true};
    };
}

export function selectFocusedPostId(postId) {
    return {
        type: PostTypes.RECEIVED_FOCUSED_POST,
        data: postId,
    };
}

export function unflagPost(postId) {
    return async (dispatch, getState) => {
        const {currentUserId} = getState().entities.users;
        const preference = {
            user_id: currentUserId,
            category: Preferences.CATEGORY_FLAGGED_POST,
            name: postId,
        };

        Client4.trackEvent('action', 'action_posts_unflag');

        return deletePreferences(currentUserId, [preference])(dispatch, getState);
    };
}

export function getOpenGraphMetadata(url) {
    return async (dispatch, getState) => {
        let data;
        try {
            data = await Client4.getOpenGraphMetadata(url);
        } catch (error) {
            forceLogoutIfNecessary(error, dispatch, getState);
            dispatch(logError(error));
            return {error};
        }

        if (data && (data.url || data.type || data.title || data.description)) {
            dispatch({
                type: PostTypes.RECEIVED_OPEN_GRAPH_METADATA,
                data,
                url,
            });
        }

        return {data};
    };
}

export function doPostAction(postId, actionId, selectedOption = '') {
    return doPostActionWithCookie(postId, actionId, '', selectedOption);
}

export function doPostActionWithCookie(postId, actionId, actionCookie, selectedOption = '') {
    return async (dispatch, getState) => {
        let data;
        try {
            data = await Client4.doPostActionWithCookie(postId, actionId, actionCookie, selectedOption);
        } catch (error) {
            forceLogoutIfNecessary(error, dispatch, getState);
            dispatch(logError(error));
            return {error};
        }

        if (data && data.trigger_id) {
            dispatch({
                type: IntegrationTypes.RECEIVED_DIALOG_TRIGGER_ID,
                data: data.trigger_id,
            });
        }

        return {data};
    };
}

export function addMessageIntoHistory(message) {
    return async (dispatch, getState) => {
        dispatch({
            type: PostTypes.ADD_MESSAGE_INTO_HISTORY,
            data: message,
        }, getState);

        return {data: true};
    };
}

export function resetHistoryIndex(index) {
    return async (dispatch, getState) => {
        dispatch({
            type: PostTypes.RESET_HISTORY_INDEX,
            data: index,
        }, getState);

        return {data: true};
    };
}

export function moveHistoryIndexBack(index) {
    return async (dispatch, getState) => {
        dispatch({
            type: PostTypes.MOVE_HISTORY_INDEX_BACK,
            data: index,
        }, getState);

        return {data: true};
    };
}

export function moveHistoryIndexForward(index) {
    return async (dispatch, getState) => {
        dispatch({
            type: PostTypes.MOVE_HISTORY_INDEX_FORWARD,
            data: index,
        }, getState);

        return {data: true};
    };
}

export function handleNewPost(msg) {
    return async (dispatch, getState) => {
        const state = getState();
        const currentUserId = getCurrentUserId(state);
        const post = JSON.parse(msg.data.post);
        const myChannelMember = getMyChannelMemberSelector(state, post.channel_id);
        const websocketMessageProps = msg.data;

        if (myChannelMember && Object.keys(myChannelMember).length === 0 && myChannelMember.constructor === 'Object') {
            await dispatch(getMyChannelMember(post.channel_id));
        }

        dispatch(completePostReceive(post, websocketMessageProps));

        if (msg.data.channel_type === General.DM_CHANNEL) {
            const otherUserId = getUserIdFromChannelName(currentUserId, msg.data.channel_name);
            dispatch(makeDirectChannelVisibleIfNecessary(otherUserId));
        } else if (msg.data.channel_type === General.GM_CHANNEL) {
            dispatch(makeGroupMessageVisibleIfNecessary(post.channel_id));
        }
    };
}

function completePostReceive(post, websocketMessageProps) {
    return async (dispatch, getState) => {
        const state = getState();
        const rootPost = Selectors.getPost(state, post.root_id);
        const postsInChannel = Selectors.getPostIdsInChannel(state, post.channel_id);

        // skip calling getPostThread if there are no postsInChannel.
        // This leads to having few posts in channel before the first visit.
        if (post.root_id && !rootPost && postsInChannel && postsInChannel.length !== 0) {
            dispatch(getPostThread(post.root_id));
        }

        dispatch(lastPostActions(post, websocketMessageProps));
    };
}

function lastPostActions(post, websocketMessageProps) {
    return async (dispatch, getState) => {
        const data = {
            order: [],
            posts: {
                [post.id]: post,
            }};
        const clearData = await decodePosts(getState, data);

        const state = getState();
        const actions = [{
            type: PostTypes.RECEIVED_POSTS,
            data: clearData,
            channelId: post.channel_id,
        }, {
            type: WebsocketEvents.STOP_TYPING,
            data: {
                id: post.channel_id + post.root_id,
                userId: post.user_id,
                now: Date.now(),
            },
        }];

        dispatch(batchActions(actions));

        if (shouldIgnorePost(post)) {
            return;
        }

        let markAsRead = false;
        let markAsReadOnServer = false;
        if (
            post.user_id === getCurrentUserId(state) &&
            !isSystemMessage(post) &&
            !isFromWebhook(post)
        ) {
            markAsRead = true;
            markAsReadOnServer = false;
        } else if (post.channel_id === getCurrentChannelId(state)) {
            markAsRead = true;
            markAsReadOnServer = true;
        }

        if (markAsRead) {
            dispatch(markChannelAsRead(post.channel_id, null, markAsReadOnServer));
            dispatch(markChannelAsViewed(post.channel_id));
        } else {
            dispatch(markChannelAsUnread(websocketMessageProps.team_id, post.channel_id, websocketMessageProps.mentions));
        }
    };
}

export default {
    createPost,
    createPostImmediately,
    resetCreatePostRequest,
    editPost,
    deletePost,
    removePost,
    getPostThread,
    getPostThreadWithRetry,
    getPosts,
    getPostsWithRetry,
    getPostsSince,
    getPostsSinceWithRetry,
    getPostsBefore,
    getPostsBeforeWithRetry,
    getPostsAfter,
    getPostsAfterWithRetry,
    selectPost,
    selectFocusedPostId,
    addMessageIntoHistory,
    resetHistoryIndex,
    moveHistoryIndexBack,
    moveHistoryIndexForward,
    handleNewPost,
};
