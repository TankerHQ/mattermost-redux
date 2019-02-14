// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.
// @flow

import Tanker from '@tanker/client-browser';

import {batchActions} from 'redux-batched-actions';
import {Client4} from 'client';
import {UserTypes} from 'action_types';

import type {ActionFunc, DispatchFunc, GetStateFunc} from 'types/actions';

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

export function openTanker(password: ?string): ActionFunc {
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
                await tanker.registerIdentity({passphrase: password});
            } else if (res === Tanker.statuses.IDENTITY_VERIFICATION_NEEDED) {
                await tanker.verifyIdentity({passphrase: password});
            }
        } catch (error) {
            handleTankerError(dispatch, getState, tanker, error);
        }
        return {data: true};
    };
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
