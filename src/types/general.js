// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.
// @flow

import Tanker from '@tanker/client-browser';

export type GeneralState = {|
    appState: boolean,
    credentials: Object,
    config: Object,
    dataRetentionPolicy: Object,
    deviceToken: string,
    license: Object,
    serverVersion: string,
    timezones: Array<string>,
    tanker: {
        enabled: boolean,
        instance: Tanker,
    },
|};
