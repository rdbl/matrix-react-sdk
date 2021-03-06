/*
Copyright 2015, 2016 OpenMarket Ltd

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

'use strict';

var React = require('react');
var classNames = require("classnames");
var Modal = require('../../../Modal');

var sdk = require('../../../index');
var MatrixClientPeg = require('../../../MatrixClientPeg')
var TextForEvent = require('../../../TextForEvent');

var ContextualMenu = require('../../structures/ContextualMenu');
var dispatcher = require("../../../dispatcher");

var ObjectUtils = require('../../../ObjectUtils');

var bounce = false;
try {
    if (global.localStorage) {
        bounce = global.localStorage.getItem('avatar_bounce') == 'true';
    }
} catch (e) {
}

var eventTileTypes = {
    'm.room.message': 'messages.MessageEvent',
    'm.room.member' : 'messages.TextualEvent',
    'm.call.invite' : 'messages.TextualEvent',
    'm.call.answer' : 'messages.TextualEvent',
    'm.call.hangup' : 'messages.TextualEvent',
    'm.room.name'   : 'messages.TextualEvent',
    'm.room.topic'  : 'messages.TextualEvent',
    'm.room.third_party_invite' : 'messages.TextualEvent',
    'm.room.history_visibility' : 'messages.TextualEvent',
    'm.room.encryption' : 'messages.TextualEvent',
};

var MAX_READ_AVATARS = 5;

// Our component structure for EventTiles on the timeline is:
//
// .-EventTile------------------------------------------------.
// | MemberAvatar (SenderProfile)                   TimeStamp |
// |    .-{Message,Textual}Event---------------. Read Avatars |
// |    |   .-MFooBody-------------------.     |              |
// |    |   |  (only if MessageEvent)    |     |              |
// |    |   '----------------------------'     |              |
// |    '--------------------------------------'              |
// '----------------------------------------------------------'

module.exports = React.createClass({
    displayName: 'EventTile',

    statics: {
        haveTileForEvent: function(e) {
            if (e.isRedacted()) return false;
            if (eventTileTypes[e.getType()] == undefined) return false;
            if (eventTileTypes[e.getType()] == 'messages.TextualEvent') {
                return TextForEvent.textForEvent(e) !== '';
            } else {
                return true;
            }
        }
    },

    propTypes: {
        /* the MatrixEvent to show */
        mxEvent: React.PropTypes.object.isRequired,

        /* true if this is a continuation of the previous event (which has the
         * effect of not showing another avatar/displayname
         */
        continuation: React.PropTypes.bool,

        /* true if this is the last event in the timeline (which has the effect
         * of always showing the timestamp)
         */
        last: React.PropTypes.bool,

        /* true if this is search context (which has the effect of greying out
         * the text
         */
        contextual: React.PropTypes.bool,

        /* a list of words to highlight, ordered by longest first */
        highlights: React.PropTypes.array,

        /* link URL for the highlights */
        highlightLink: React.PropTypes.string,

        /* should show URL previews for this event */
        showUrlPreview: React.PropTypes.bool,

        /* is this the focused event */
        isSelectedEvent: React.PropTypes.bool,

        /* callback called when dynamic content in events are loaded */
        onWidgetLoad: React.PropTypes.func,

        /* a list of Room Members whose read-receipts we should show */
        readReceipts: React.PropTypes.arrayOf(React.PropTypes.object),

        /* opaque readreceipt info for each userId; used by ReadReceiptMarker
         * to manage its animations. Should be an empty object when the room
         * first loads
         */
        readReceiptMap: React.PropTypes.object,

        /* A function which is used to check if the parent panel is being
         * unmounted, to avoid unnecessary work. Should return true if we
         * are being unmounted.
         */
        checkUnmounting: React.PropTypes.func,

        /* the status of this event - ie, mxEvent.status. Denormalised to here so
         * that we can tell when it changes. */
        eventSendStatus: React.PropTypes.string,

        /* the shape of the tile. by default, the layout is intended for the
         * normal room timeline.  alternative values are: "file_list", "file_grid"
         * and "notif".  This could be done by CSS, but it'd be horribly inefficient.
         * It could also be done by subclassing EventTile, but that'd be quite
         * boiilerplatey.  So just make the necessary render decisions conditional
         * for now.
         */
        tileShape: React.PropTypes.string,
    },

    getInitialState: function() {
        return {menu: false, allReadAvatars: false, verified: null};
    },

    componentWillMount: function() {
        // don't do RR animations until we are mounted
        this._suppressReadReceiptAnimation = true;
        this._verifyEvent(this.props.mxEvent);
    },

    componentDidMount: function() {
        this._suppressReadReceiptAnimation = false;
        MatrixClientPeg.get().on("deviceVerificationChanged",
                                 this.onDeviceVerificationChanged);
    },

    componentWillReceiveProps: function (nextProps) {
        if (nextProps.mxEvent !== this.props.mxEvent) {
            this._verifyEvent(nextProps.mxEvent);
        }
    },

    shouldComponentUpdate: function (nextProps, nextState) {
        if (!ObjectUtils.shallowEqual(this.state, nextState)) {
            return true;
        }

        if (!this._propsEqual(this.props, nextProps)) {
            return true;
        }

        return false;
    },

    componentWillUnmount: function() {
        var client = MatrixClientPeg.get();
        if (client) {
            client.removeListener("deviceVerificationChanged",
                                  this.onDeviceVerificationChanged);
        }
    },

    onDeviceVerificationChanged: function(userId, device) {
        if (userId == this.props.mxEvent.getSender()) {
            this._verifyEvent(this.props.mxEvent);
        }
    },

    _verifyEvent: function(mxEvent) {
        var verified = null;

        if (mxEvent.isEncrypted()) {
            verified = MatrixClientPeg.get().isEventSenderVerified(mxEvent);
        }

        this.setState({
            verified: verified
        });
    },

    _propsEqual: function(objA, objB) {
        var keysA = Object.keys(objA);
        var keysB = Object.keys(objB);

        if (keysA.length !== keysB.length) {
            return false;
        }

        for (var i = 0; i < keysA.length; i++) {
            var key = keysA[i];

            if (!objB.hasOwnProperty(key)) {
                return false;
            }

            // need to deep-compare readReceipts
            if (key == 'readReceipts') {
                var rA = objA[key];
                var rB = objB[key];
                if (rA === rB) {
                    continue;
                }

                if (!rA || !rB) {
                    return false;
                }

                if (rA.length !== rB.length) {
                    return false;
                }
                for (var j = 0; j < rA.length; j++) {
                    if (rA[j].userId !== rB[j].userId) {
                        return false;
                    }
                }
            } else {
                if (objA[key] !== objB[key]) {
                    return false;
                }
            }
        }
        return true;
    },

    shouldHighlight: function() {
        var actions = MatrixClientPeg.get().getPushActionsForEvent(this.props.mxEvent);
        if (!actions || !actions.tweaks) { return false; }

        // don't show self-highlights from another of our clients
        if (this.props.mxEvent.getSender() === MatrixClientPeg.get().credentials.userId)
        {
            return false;
        }

        return actions.tweaks.highlight;
    },

    onEditClicked: function(e) {
        var MessageContextMenu = sdk.getComponent('context_menus.MessageContextMenu');
        var buttonRect = e.target.getBoundingClientRect()

        // The window X and Y offsets are to adjust position when zoomed in to page
        var x = buttonRect.right + window.pageXOffset;
        var y = (buttonRect.top + (e.target.height / 2) + window.pageYOffset) - 19;
        var self = this;
        ContextualMenu.createMenu(MessageContextMenu, {
            chevronOffset: 10,
            mxEvent: this.props.mxEvent,
            left: x,
            top: y,
            eventTileOps: this.refs.tile && this.refs.tile.getEventTileOps ? this.refs.tile.getEventTileOps() : undefined,
            onFinished: function() {
                self.setState({menu: false});
            }
        });
        this.setState({menu: true});
    },

    toggleAllReadAvatars: function() {
        this.setState({
            allReadAvatars: !this.state.allReadAvatars
        });
    },

    getReadAvatars: function() {
        var ReadReceiptMarker = sdk.getComponent('rooms.ReadReceiptMarker');
        var avatars = [];

        var left = 0;

        var receipts = this.props.readReceipts || [];
        for (var i = 0; i < receipts.length; ++i) {
            var member = receipts[i];

            var hidden = true;
            if ((i < MAX_READ_AVATARS) || this.state.allReadAvatars) {
                hidden = false;
            }

            var userId = member.userId;
            var readReceiptInfo;

            if (this.props.readReceiptMap) {
                readReceiptInfo = this.props.readReceiptMap[userId];
                if (!readReceiptInfo) {
                    readReceiptInfo = {};
                    this.props.readReceiptMap[userId] = readReceiptInfo;
                }
            }

            //console.log("i = " + i + ", MAX_READ_AVATARS = " + MAX_READ_AVATARS + ", allReadAvatars = " + this.state.allReadAvatars + " visibility = " + style.visibility);

            // add to the start so the most recent is on the end (ie. ends up rightmost)
            avatars.unshift(
                <ReadReceiptMarker key={userId} member={member}
                    leftOffset={left} hidden={hidden}
                    readReceiptInfo={readReceiptInfo}
                    checkUnmounting={this.props.checkUnmounting}
                    suppressAnimation={this._suppressReadReceiptAnimation}
                    onClick={this.toggleAllReadAvatars}
                />
            );

            // TODO: we keep the extra read avatars in the dom to make animation simpler
            // we could optimise this to reduce the dom size.
            if (!hidden) {
                left -= 15;
            }
        }
        var remText;
        if (!this.state.allReadAvatars) {
            var remainder = receipts.length - MAX_READ_AVATARS;
            if (remainder > 0) {
                remText = <span className="mx_EventTile_readAvatarRemainder"
                    onClick={this.toggleAllReadAvatars}
                    style={{ left: left }}>{ remainder }+
                </span>;
                left -= 15;
            }
        }

        return <span className="mx_EventTile_readAvatars">
            { remText }
            { avatars }
        </span>;
    },

    onMemberAvatarClick: function(event) {
        dispatcher.dispatch({
            action: 'view_user',
            member: this.props.mxEvent.sender,
        });
    },

    onSenderProfileClick: function(event) {
        var mxEvent = this.props.mxEvent;
        dispatcher.dispatch({
            action: 'insert_displayname',
            displayname: mxEvent.sender ? mxEvent.sender.name : mxEvent.getSender(),
        });
    },

    onCryptoClicked: function(e) {
        var EncryptedEventDialog = sdk.getComponent("dialogs.EncryptedEventDialog");
        var event = this.props.mxEvent;

        Modal.createDialog(EncryptedEventDialog, {
            event: event,
        });
    },

    render: function() {
        var MessageTimestamp = sdk.getComponent('messages.MessageTimestamp');
        var SenderProfile = sdk.getComponent('messages.SenderProfile');
        var MemberAvatar = sdk.getComponent('avatars.MemberAvatar');

        //console.log("EventTile showUrlPreview for %s is %s", this.props.mxEvent.getId(), this.props.showUrlPreview);

        var content = this.props.mxEvent.getContent();
        var msgtype = content.msgtype;
        var eventType = this.props.mxEvent.getType();

        // Info messages are basically information about commands processed on a
        // room, or emote messages
        var isInfoMessage = (eventType !== 'm.room.message');

        var EventTileType = sdk.getComponent(eventTileTypes[eventType]);
        // This shouldn't happen: the caller should check we support this type
        // before trying to instantiate us
        if (!EventTileType) {
            throw new Error("Event type not supported");
        }

        var e2eEnabled = MatrixClientPeg.get().isRoomEncrypted(this.props.mxEvent.getRoomId());
        var isSending = (['sending', 'queued', 'encrypting'].indexOf(this.props.eventSendStatus) !== -1);

        var classes = classNames({
            mx_EventTile: true,
            mx_EventTile_info: isInfoMessage,
            mx_EventTile_encrypting: this.props.eventSendStatus == 'encrypting',
            mx_EventTile_sending: isSending,
            mx_EventTile_notSent: this.props.eventSendStatus == 'not_sent',
            mx_EventTile_highlight: this.props.tileShape == 'notif' ? false : this.shouldHighlight(),
            mx_EventTile_selected: this.props.isSelectedEvent,
            mx_EventTile_continuation: this.props.tileShape ? '' : this.props.continuation,
            mx_EventTile_last: this.props.last,
            mx_EventTile_contextual: this.props.contextual,
            menu: this.state.menu,
            mx_EventTile_verified: this.state.verified == true,
            mx_EventTile_unverified: this.state.verified == false,
            mx_EventTile_bad: this.props.mxEvent.getContent().msgtype === 'm.bad.encrypted',
        });
        var permalink = "#/room/" + this.props.mxEvent.getRoomId() +"/"+ this.props.mxEvent.getId();

        var readAvatars = this.getReadAvatars();

        var avatar, sender;
        let avatarSize;
        let needsSenderProfile;

        if (this.props.tileShape === "notif") {
            avatarSize = 24;
            needsSenderProfile = true;
        } else if (isInfoMessage) {
            // a small avatar, with no sender profile, for
            // joins/parts/etc
            avatarSize = 14;
            needsSenderProfile = false;
        } else if (this.props.continuation && this.props.tileShape !== "file_grid") {
            // no avatar or sender profile for continuation messages
            avatarSize = 0;
            needsSenderProfile = false;
        } else {
            avatarSize = 30;
            needsSenderProfile = true;
        }

        if (this.props.mxEvent.sender && avatarSize) {
            avatar = (
                    <div className="mx_EventTile_avatar">
                        <MemberAvatar member={this.props.mxEvent.sender}
                            width={avatarSize} height={avatarSize}
                            onClick={ this.onMemberAvatarClick }
                        />
                    </div>
            );
        }

        if (needsSenderProfile) {
            let aux = null;
            if (!this.props.tileShape) {
                if (msgtype === 'm.image') aux = "sent an image";
                else if (msgtype === 'm.video') aux = "sent a video";
                else if (msgtype === 'm.file') aux = "uploaded a file";
                sender = <SenderProfile onClick={ this.onSenderProfileClick } mxEvent={this.props.mxEvent} aux={aux} />;
            }
            else {
                sender = <SenderProfile mxEvent={this.props.mxEvent} />;
            }
        }

        var editButton = (
            <img className="mx_EventTile_editButton" src="img/icon_context_message.svg" width="19" height="19" alt="Options" title="Options" onClick={this.onEditClicked} />
        );

        var e2e;
        // cosmetic padlocks:
        if ((e2eEnabled && this.props.eventSendStatus) || this.props.mxEvent.getType() === 'm.room.encryption') {
            e2e = <img style={{ cursor: 'initial', marginLeft: '-1px' }} className="mx_EventTile_e2eIcon" src="img/e2e-verified.svg" width="10" height="12" />;
        }
        // real padlocks
        else if (this.props.mxEvent.isEncrypted() || (e2eEnabled && this.props.eventSendStatus)) {
            if (this.props.mxEvent.getContent().msgtype === 'm.bad.encrypted') {
                e2e = <img onClick={ this.onCryptoClicked } className="mx_EventTile_e2eIcon" src="img/e2e-blocked.svg" width="12" height="12" style={{ marginLeft: "-1px" }} />;
            }
            else if (this.state.verified == true || (e2eEnabled && this.props.eventSendStatus)) {
                e2e = <img onClick={ this.onCryptoClicked } className="mx_EventTile_e2eIcon" src="img/e2e-verified.svg" width="10" height="12"/>;
            }
            else {
                e2e = <img onClick={ this.onCryptoClicked } className="mx_EventTile_e2eIcon" src="img/e2e-warning.svg" width="15" height="12" style={{ marginLeft: "-2px" }}/>;
            }
        }
        else if (e2eEnabled) {
            e2e = <img onClick={ this.onCryptoClicked } className="mx_EventTile_e2eIcon" src="img/e2e-unencrypted.svg" width="12" height="12"/>;
        }

        if (this.props.tileShape === "notif") {
            var room = MatrixClientPeg.get().getRoom(this.props.mxEvent.getRoomId());

            return (
                <div className={classes}>
                    <div className="mx_EventTile_roomName">
                        <a href={ permalink }>
                            { room ? room.name : '' }
                        </a>
                    </div>
                    <div className="mx_EventTile_senderDetails">
                        { avatar }
                        <a href={ permalink }>
                            { sender }
                            <MessageTimestamp ts={this.props.mxEvent.getTs()} />
                        </a>
                    </div>
                    <div className="mx_EventTile_line" >
                        <EventTileType ref="tile"
                            mxEvent={this.props.mxEvent}
                            highlights={this.props.highlights}
                            highlightLink={this.props.highlightLink}
                            showUrlPreview={this.props.showUrlPreview}
                            onWidgetLoad={this.props.onWidgetLoad} />
                    </div>
                </div>
            );
        }
        else if (this.props.tileShape === "file_grid") {
            return (
                <div className={classes}>
                    <div className="mx_EventTile_line" >
                        <EventTileType ref="tile"
                            mxEvent={this.props.mxEvent}
                            highlights={this.props.highlights}
                            highlightLink={this.props.highlightLink}
                            showUrlPreview={this.props.showUrlPreview}
                            tileShape={this.props.tileShape}
                            onWidgetLoad={this.props.onWidgetLoad} />
                    </div>
                    <a className="mx_EventTile_senderDetailsLink" href={ permalink }>
                        <div className="mx_EventTile_senderDetails">
                                { sender }
                                <MessageTimestamp ts={this.props.mxEvent.getTs()} />
                        </div>
                    </a>
                </div>
            );
        }
        else {
            return (
                <div className={classes}>
                    <div className="mx_EventTile_msgOption">
                        { readAvatars }
                    </div>
                    { avatar }
                    { sender }
                    <div className="mx_EventTile_line">
                        <a href={ permalink }>
                            <MessageTimestamp ts={this.props.mxEvent.getTs()} />
                        </a>
                        { e2e }
                        <EventTileType ref="tile"
                            mxEvent={this.props.mxEvent}
                            highlights={this.props.highlights}
                            highlightLink={this.props.highlightLink}
                            showUrlPreview={this.props.showUrlPreview}
                            onWidgetLoad={this.props.onWidgetLoad} />
                        { editButton }
                    </div>
                </div>
            );
        }
    },
});
