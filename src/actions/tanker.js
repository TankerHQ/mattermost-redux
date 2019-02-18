// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.
// @flow

import Tanker, {toBase64, fromBase64} from '@tanker/client-browser';

import {batchActions} from 'redux-batched-actions';
import {updateChannel} from 'actions/channels';
import {Client4} from 'client';
import {UserTypes} from 'action_types';

import type {ActionFunc, DispatchFunc, GetStateFunc} from 'types/actions';
import type {Channel} from 'types/channels';
import type {Post} from 'types/posts';

export const tankerConfig = {
    trustchainId: 'mQ2X4rM+UWVVg2eC6aTh0nf8knWFI1Yg7JxaB0U2p94=',
};

async function handleTankerError(dispatch: DispatchFunc, getState: GetStateFunc, tanker: Tanker, error: string): Promise<void> {
    await Client4.logout();
    await tanker.close();
    dispatch(batchActions([
        {
            type: UserTypes.LOGIN_FAILURE,
            error,
        },
    ]), getState);
}

export function openTanker(email: ?string, password: ?string): ActionFunc {
    return async (dispatch: DispatchFunc, getState: GetStateFunc) => {
        const tankerState = getState().entities.general.tanker;
        if (!tankerState.enabled) {
            return {data: true};
        }
        const tanker = tankerState.instance;
        let token;
        try {
            token = await Client4.getUserToken();
        } catch (error) {
            token = null;
        }
        if (token) {
            tanker.on('unlockRequired', async () => {
                try {
                    await tanker.unlockCurrentDevice({password});
                } catch (error) {
                    handleTankerError(dispatch, getState, tanker, error);
                }
            });

            try {
                await tanker.open(token.user_id, token.token);

                if (!tanker.hasRegisteredUnlockMethod('email') ||
                    !tanker.hasRegisteredUnlockMethod('password')) {
                    await tanker.registerUnlock({email, password});
                }
            } catch (error) {
                handleTankerError(dispatch, getState, tanker, error);
            }
        }
        return {data: true};
    };
}

export async function createGroup(getState: GetStateFunc, channelMembers: Array<string>) {
    const tankerState = getState().entities.general.tanker;
    if (!tankerState.enabled) {
        return '';
    }
    const tanker = tankerState.instance;
    return tanker.createGroup(channelMembers);
}

export async function updateChannelGroup(getState: GetStateFunc, channel: Channel, toAddUserIds: Array<string>) {
    const tankerState = getState().entities.general.tanker;
    if (!tankerState.enabled) {
        return channel;
    }
    const tanker = tankerState.instance;

    if (channel.tanker_group_id) {
        await tanker.updateGroup(channel.tanker_group_id, {usersToAdd: toAddUserIds});
    } else {
        const channelMembers = getMembersList(getState, channel.id).concat(toAddUserIds);
        const newGroupID = await tanker.createGroup(channelMembers);
        channel.tanker_group_id = newGroupID;
    }
    return channel;
}

function getMembersList(getState: GetStateFunc, channelId: string) {
    const members = getState().entities.channels.membersInChannel[channelId];
    const results = [];
    Object.keys(members).forEach((member) => {
        if (typeof member === 'string') {
            results.push(member);
        } else if (member.user_id) {
            results.push(member.user_id);
        }
    });
    return results;
}

export async function encodeMessage(dispatch: DispatchFunc, getState: GetStateFunc, message: string, channelId: string) {
    const state = getState();
    const tankerState = state.entities.general.tanker;
    if (!tankerState.enabled) {
        return message;
    }
    const tanker = tankerState.instance;
    let channel = state.entities.channels.channels[channelId];

    if (!channel.tanker_group_id) {
        channel = await updateChannelGroup(getState, channel, []);
        await updateChannel(channel)(dispatch, getState);
    }

    const encryptedData = await tanker.encrypt(message, {shareWithGroups: [channel.tanker_group_id]});
    return toBase64(encryptedData);
}

export async function decodePosts(getState: GetStateFunc, data: Object): Promise<Object> {
    const clearPosts = {};

    const promises = Object.entries(data.posts).map(async ([id, p]) => {
        const post = ((p: any): Post);
        clearPosts[id] = await decodePost(getState, post);
    });

    await Promise.all(promises);

    return {...data, posts: clearPosts};
}

export async function decodePost(getState: GetStateFunc, post: Post) {
    const tankerState = getState().entities.general.tanker;
    if (!tankerState.enabled) {
        return post;
    }
    const tanker = tankerState.instance;
    try {
        const clearMessage = await tanker.decrypt(fromBase64(post.message));
        return {...post, message: clearMessage};
    } catch (e) {
        return post;
    }
}

export async function closeTanker(getState: GetStateFunc) {
    const tankerState = getState().entities.general.tanker;
    if (!tankerState.enabled) {
        return;
    }
    const tanker = tankerState.instance;
    await tanker.close();
}

export async function updateTankerPassword(getState: GetStateFunc, newPassword: string) {
    const tankerState = getState().entities.general.tanker;
    if (!tankerState.enabled) {
        return;
    }
    const tanker = tankerState.instance;
    await tanker.registerUnlock({password: newPassword});
}

export async function unlockAndUpdatePassword(getState: GetStateFunc, userId: string, userToken: string, verificationCode: string, newPassword: string) {
    const tankerState = getState().entities.general.tanker;
    if (!tankerState.enabled) {
        return;
    }
    const tanker = tankerState.instance;

    tanker.on('unlockRequired', async () => {
        await tanker.unlockCurrentDevice({verificationCode});
    });
    await tanker.open(userId, userToken);
    await tanker.registerUnlock({password: newPassword});
    await tanker.close();
}
