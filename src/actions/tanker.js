// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.
// @flow

import Tanker, {toBase64, fromBase64} from '@tanker/client-browser';

import {batchActions} from 'redux-batched-actions';
import {updateChannel, getChannelMembers} from 'actions/channels';
import {Client4} from 'client';
import {UserTypes} from 'action_types';

import type {ActionFunc, DispatchFunc, GetStateFunc} from 'types/actions';
import type {Post} from 'types/posts';

export const tankerConfig = {
    trustchainId: 'mQ2X4rM+UWVVg2eC6aTh0nf8knWFI1Yg7JxaB0U2p94=',
};

async function handleTankerError(dispatch: DispatchFunc, getState: GetStateFunc, tanker: Tanker, error: string): Promise<void> {
    await Client4.logout();
    await tanker.signOut();
    dispatch(batchActions([
        {
            type: UserTypes.LOGIN_FAILURE,
            error,
        },
    ]), getState);
}

export function openTanker(email: ?string, password: ?string, validationCode: ?string): ActionFunc {
    return async (dispatch: DispatchFunc, getState: GetStateFunc) => {
        const tankerState = getState().entities.general.tanker;
        if (!tankerState.enabled) {
            return {data: true};
        }
        const tanker = tankerState.instance;

        try {
            const ids = await Client4.getTankerIdentity();
            const res = await tanker.start(ids.tanker_identity);
            if (res === Tanker.statuses.IDENTITY_REGISTRATION_NEEDED) {
                if (!email) {
                    handleTankerError(dispatch, getState, tanker, 'Cannot sign up without email');
                }
                await tanker.registerIdentity({passphrase: password});
                await tanker.updateVerificationMethod({email, verificationCode: ''});
                try {
                    await tanker.claimProvisionalIdentity(ids.provisional_identity, validationCode);
                } catch (e) {
                    console.error(e); // eslint-disable-line no-console
                }
            } else if (res === Tanker.statuses.IDENTITY_VERIFICATION_NEEDED) {
                await tanker.verifyIdentity({passphrase: password});
            }
        } catch (error) {
            handleTankerError(dispatch, getState, tanker, error);
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
    const publicIdentities = await Client4.getTankerPublicIdentities(channelMembers);
    return tanker.createGroup(publicIdentities);
}

export async function addMemberToChannelGroup(dispatch: DispatchFunc, getState: GetStateFunc, channelId: string, toAddUserId: string) {
    const tankerState = getState().entities.general.tanker;
    if (!tankerState.enabled) {
        return;
    }
    const tanker = tankerState.instance;

    const channel = getState().entities.channels.channels[channelId];
    if (!channel.tanker_group_id) {
        await createChannelGroup(dispatch, getState, channelId);
    }
    const publicIdentities = await Client4.getTankerPublicIdentities([toAddUserId]);
    await tanker.updateGroupMembers(channel.tanker_group_id, {usersToAdd: publicIdentities});
}

export async function inviteToTeamChannels(getState: GetStateFunc, userIds: Array<string>, publicProvisionalIdentities: Array<string>) {
    const tankerState = getState().entities.general.tanker;
    if (!tankerState.enabled) {
        return;
    }
    const tanker = tankerState.instance;

    const teams = await Client4.getMyTeams();

    const teamChannels = await Promise.all(teams.map((team) => Client4.getMyChannels(team.id)));
    const channels = teamChannels.reduce((acc, val) => acc.concat(val), []);

    let publicIdentities = await Client4.getTankerPublicIdentities(userIds);
    if (publicIdentities) {
        publicIdentities = publicIdentities.concat(publicProvisionalIdentities);
    } else {
        publicIdentities = publicProvisionalIdentities;
    }

    const promises = channels.filter((channel) => channel.type === 'O').map(async (channel) => {
        return tanker.updateGroupMembers(channel.tanker_group_id, {usersToAdd: publicIdentities});
    });

    await Promise.all(promises);
}

export async function createTeamChannelsGroups(dispatch: DispatchFunc, getState: GetStateFunc, teamId: string) {
    const tankerState = getState().entities.general.tanker;
    if (!tankerState.enabled) {
        return;
    }

    const teamChannels = await Client4.getMyChannels(teamId);
    const channels = teamChannels.reduce((acc, val) => acc.concat(val), []);

    const promises = channels.map(async (channel) => {
        createChannelGroup(dispatch, getState, channel.id);
    });

    await Promise.all(promises);
}

function getMembersList(members) {
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

async function createChannelGroup(dispatch: DispatchFunc, getState: GetStateFunc, channelId: string) {
    // make sure the channel is up to date
    const channel = await Client4.getChannel(channelId);
    await getChannelMembers(channelId)(dispatch, getState);

    const members = getState().entities.channels.membersInChannel[channelId];

    channel.tanker_group_id = await createGroup(getState, getMembersList(members));
    await updateChannel(channel)(dispatch, getState);
}

export async function encodeMessage(dispatch: DispatchFunc, getState: GetStateFunc, message: string, channelId: string) {
    const state = getState();
    const tankerState = state.entities.general.tanker;
    if (!tankerState.enabled) {
        return message;
    }
    const tanker = tankerState.instance;
    const channel = state.entities.channels.channels[channelId];

    if (!channel.tanker_group_id) {
        await createChannelGroup(dispatch, getState, channelId);
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

export async function encryptFile(dispatch: DispatchFunc, getState: GetStateFunc, file: File, channelId: string) {
    const state = getState();
    const tankerState = state.entities.general.tanker;
    if (!tankerState.enabled) {
        return file;
    }
    const tanker = tankerState.instance;
    const channel = state.entities.channels.channels[channelId];

    if (!channel.tanker_group_id) {
        await createChannelGroup(dispatch, getState, channelId);
    }

    return tanker.encryptData(file, {shareWithGroups: [channel.tanker_group_id]});
}

export async function decryptFile(dispatch: DispatchFunc, getState: GetStateFunc, file: File) {
    const tankerState = getState().entities.general.tanker;
    if (!tankerState.enabled) {
        return file;
    }
    const tanker = tankerState.instance;

    return tanker.decryptData(file);
}

export async function closeTanker(getState: GetStateFunc) {
    const tankerState = getState().entities.general.tanker;
    if (!tankerState.enabled) {
        return;
    }
    const tanker = tankerState.instance;
    await tanker.stop();
}

export async function updateTankerPassword(getState: GetStateFunc, newPassword: string) {
    const tankerState = getState().entities.general.tanker;
    if (!tankerState.enabled) {
        return;
    }
    const tanker = tankerState.instance;
    await tanker.updateVerificationMethod({passphrase: newPassword});
}

export async function unlockAndUpdatePassword(getState: GetStateFunc, email: string, tankerIdentity: string, verificationCode: string, newPassword: string) {
    const tankerState = getState().entities.general.tanker;
    if (!tankerState.enabled) {
        return;
    }
    const tanker = tankerState.instance;
    const status = await tanker.start(tankerIdentity);
    if (status === Tanker.statuses.IDENTITY_VERIFICATION_NEEDED) {
        await tanker.verifyIdentity({email, verificationCode});
    }
    await tanker.updateVerificationMethod({passphrase: newPassword});
    await tanker.stop();
}
