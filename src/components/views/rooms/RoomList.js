/*
Copyright 2015, 2016 OpenMarket Ltd
Copyright 2017 Vector Creations Ltd

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
const React = require("react");
const ReactDOM = require("react-dom");
import { _t } from '../../../languageHandler';
const GeminiScrollbar = require('react-gemini-scrollbar');
const MatrixClientPeg = require("../../../MatrixClientPeg");
const CallHandler = require('../../../CallHandler');
const dis = require("../../../dispatcher");
const sdk = require('../../../index');
const rate_limited_func = require('../../../ratelimitedfunc');
const Rooms = require('../../../Rooms');
import DMRoomMap from '../../../utils/DMRoomMap';
const Receipt = require('../../../utils/Receipt');
import FilterStore from '../../../stores/FilterStore';
import GroupStoreCache from '../../../stores/GroupStoreCache';

const HIDE_CONFERENCE_CHANS = true;

function phraseForSection(section) {
    switch (section) {
        case 'm.favourite':
            return _t('Drop here to favourite');
        case 'im.vector.fake.direct':
            return _t('Drop here to tag direct chat');
        case 'im.vector.fake.recent':
            return _t('Drop here to restore');
        case 'm.lowpriority':
            return _t('Drop here to demote');
        default:
            return _t('Drop here to tag %(section)s', {section: section});
    }
}

module.exports = React.createClass({
    displayName: 'RoomList',

    propTypes: {
        ConferenceHandler: React.PropTypes.any,
        collapsed: React.PropTypes.bool.isRequired,
        searchFilter: React.PropTypes.string,
    },

    getInitialState: function() {
        return {
            isLoadingLeftRooms: false,
            totalRoomCount: null,
            lists: {},
            incomingCall: null,
            selectedTags: [],
        };
    },

    componentWillMount: function() {
        this.mounted = false;

        const cli = MatrixClientPeg.get();

        cli.on("Room", this.onRoom);
        cli.on("deleteRoom", this.onDeleteRoom);
        cli.on("Room.timeline", this.onRoomTimeline);
        cli.on("Room.name", this.onRoomName);
        cli.on("Room.tags", this.onRoomTags);
        cli.on("Room.receipt", this.onRoomReceipt);
        cli.on("RoomState.events", this.onRoomStateEvents);
        cli.on("RoomMember.name", this.onRoomMemberName);
        cli.on("Event.decrypted", this.onEventDecrypted);
        cli.on("accountData", this.onAccountData);
        cli.on("Group.myMembership", this._onGroupMyMembership);

        const dmRoomMap = DMRoomMap.shared();
        this._groupStores = {};
        // A map between tags which are group IDs and the room IDs of rooms that should be kept
        // in the room list when filtering by that tag.
        this._selectedTagsRoomIdsForGroup = {
            // $groupId: [$roomId1, $roomId2, ...],
        };
        // All rooms that should be kept in the room list when filtering
        this._selectedTagsRoomIds = [];
        // When the selected tags are changed, initialise a group store if necessary
        this._filterStoreToken = FilterStore.addListener(() => {
            FilterStore.getSelectedTags().forEach((tag) => {
                if (tag[0] !== '+' || this._groupStores[tag]) {
                    return;
                }
                this._groupStores[tag] = GroupStoreCache.getGroupStore(tag);
                this._groupStores[tag].registerListener(() => {
                    // This group's rooms or members may have updated, update rooms for its tag
                    this.updateSelectedTagsRooms(dmRoomMap, [tag]);
                });
            });
            // Filters themselves have changed, refresh the selected tags
            this.updateSelectedTagsRooms(dmRoomMap, FilterStore.getSelectedTags());
        });

        this.refreshRoomList();

        // order of the sublists
        //this.listOrder = [];

        // loop count to stop a stack overflow if the user keeps waggling the
        // mouse for >30s in a row, or if running under mocha
        this._delayedRefreshRoomListLoopCount = 0;
    },

    componentDidMount: function() {
        this.dispatcherRef = dis.register(this.onAction);
        // Initialise the stickyHeaders when the component is created
        this._updateStickyHeaders(true);

        this.mounted = true;
    },

    componentDidUpdate: function() {
        // Reinitialise the stickyHeaders when the component is updated
        this._updateStickyHeaders(true);
        this._repositionIncomingCallBox(undefined, false);
    },

    onAction: function(payload) {
        switch (payload.action) {
            case 'view_tooltip':
                this.tooltip = payload.tooltip;
                break;
            case 'call_state':
                var call = CallHandler.getCall(payload.room_id);
                if (call && call.call_state === 'ringing') {
                    this.setState({
                        incomingCall: call,
                    });
                    this._repositionIncomingCallBox(undefined, true);
                } else {
                    this.setState({
                        incomingCall: null,
                    });
                }
                break;
            case 'on_room_read':
                // Force an update because the notif count state is too deep to cause
                // an update. This forces the local echo of reading notifs to be
                // reflected by the RoomTiles.
                this.forceUpdate();
                break;
        }
    },

    componentWillUnmount: function() {
        this.mounted = false;

        dis.unregister(this.dispatcherRef);
        if (MatrixClientPeg.get()) {
            MatrixClientPeg.get().removeListener("Room", this.onRoom);
            MatrixClientPeg.get().removeListener("deleteRoom", this.onDeleteRoom);
            MatrixClientPeg.get().removeListener("Room.timeline", this.onRoomTimeline);
            MatrixClientPeg.get().removeListener("Room.name", this.onRoomName);
            MatrixClientPeg.get().removeListener("Room.tags", this.onRoomTags);
            MatrixClientPeg.get().removeListener("Room.receipt", this.onRoomReceipt);
            MatrixClientPeg.get().removeListener("RoomState.events", this.onRoomStateEvents);
            MatrixClientPeg.get().removeListener("RoomMember.name", this.onRoomMemberName);
            MatrixClientPeg.get().removeListener("Event.decrypted", this.onEventDecrypted);
            MatrixClientPeg.get().removeListener("accountData", this.onAccountData);
            MatrixClientPeg.get().removeListener("Group.myMembership", this._onGroupMyMembership);
        }

        if (this._filterStoreToken) {
            this._filterStoreToken.remove();
        }

        // cancel any pending calls to the rate_limited_funcs
        this._delayedRefreshRoomList.cancelPendingCall();
    },

    onRoom: function(room) {
        this._delayedRefreshRoomList();
    },

    onDeleteRoom: function(roomId) {
        this._delayedRefreshRoomList();
    },

    onArchivedHeaderClick: function(isHidden, scrollToPosition) {
        if (!isHidden) {
            const self = this;
            this.setState({ isLoadingLeftRooms: true });

            // Try scrolling to position
            this._updateStickyHeaders(true, scrollToPosition);

            // we don't care about the response since it comes down via "Room"
            // events.
            MatrixClientPeg.get().syncLeftRooms().catch(function(err) {
                console.error("Failed to sync left rooms: %s", err);
                console.error(err);
            }).finally(function() {
                self.setState({ isLoadingLeftRooms: false });
            });
        }
    },

    onSubListHeaderClick: function(isHidden, scrollToPosition) {
        // The scroll area has expanded or contracted, so re-calculate sticky headers positions
        this._updateStickyHeaders(true, scrollToPosition);
    },

    onRoomTimeline: function(ev, room, toStartOfTimeline, removed, data) {
        if (toStartOfTimeline) return;
        if (!room) return;
        if (data.timeline.getTimelineSet() !== room.getUnfilteredTimelineSet()) return;
        this._delayedRefreshRoomList();
    },

    onRoomReceipt: function(receiptEvent, room) {
        // because if we read a notification, it will affect notification count
        // only bother updating if there's a receipt from us
        if (Receipt.findReadReceiptFromUserId(receiptEvent, MatrixClientPeg.get().credentials.userId)) {
            this._delayedRefreshRoomList();
        }
    },

    onRoomName: function(room) {
        this._delayedRefreshRoomList();
    },

    onRoomTags: function(event, room) {
        this._delayedRefreshRoomList();
    },

    onRoomStateEvents: function(ev, state) {
        this._delayedRefreshRoomList();
    },

    onRoomMemberName: function(ev, member) {
        this._delayedRefreshRoomList();
    },

    onEventDecrypted: function(ev) {
        // An event being decrypted may mean we need to re-order the room list
        this._delayedRefreshRoomList();
    },

    onAccountData: function(ev) {
        if (ev.getType() == 'm.direct') {
            this._delayedRefreshRoomList();
        }
    },

    _onGroupMyMembership: function(group) {
        this.forceUpdate();
    },

    _delayedRefreshRoomList: new rate_limited_func(function() {
        this.refreshRoomList();
    }, 500),

    // Update which rooms and users should appear in RoomList as dictated by selected tags
    updateSelectedTagsRooms: function(dmRoomMap, updatedTags) {
        if (!this.mounted) return;
        updatedTags.forEach((tag) => {
            // For now, only handle group tags
            const store = this._groupStores[tag];
            if (!store) return;

            this._selectedTagsRoomIdsForGroup[tag] = [];
            store.getGroupRooms().forEach((room) => this._selectedTagsRoomIdsForGroup[tag].push(room.roomId));
            store.getGroupMembers().forEach((member) => {
                if (member.userId === MatrixClientPeg.get().credentials.userId) return;
                dmRoomMap.getDMRoomsForUserId(member.userId).forEach(
                    (roomId) => this._selectedTagsRoomIdsForGroup[tag].push(roomId),
                );
            });
            // TODO: Check if room has been tagged to the group by the user
        });

        this._selectedTagsRoomIds = [];
        FilterStore.getSelectedTags().forEach((tag) => {
            (this._selectedTagsRoomIdsForGroup[tag] || []).forEach(
                (roomId) => this._selectedTagsRoomIds.push(roomId),
            );
        });

        this.setState({
            selectedTags: FilterStore.getSelectedTags(),
        }, () => {
            this.refreshRoomList();
        });
    },

    isRoomInSelectedTags: function(room) {
        // No selected tags = every room is visible in the list
        return this.state.selectedTags.length === 0 || this._selectedTagsRoomIds.includes(room.roomId);
    },

    refreshRoomList: function() {
        // TODO: ideally we'd calculate this once at start, and then maintain
        // any changes to it incrementally, updating the appropriate sublists
        // as needed.
        // Alternatively we'd do something magical with Immutable.js or similar.
        const lists = this.getRoomLists();
        let totalRooms = 0;
        for (const l of Object.values(lists)) {
            totalRooms += l.length;
        }
        this.setState({
            lists: this.getRoomLists(),
            totalRoomCount: totalRooms,
        });

        // this._lastRefreshRoomListTs = Date.now();
    },

    getRoomLists: function() {
        const lists = {};
        lists["im.vector.fake.invite"] = [];
        lists["m.favourite"] = [];
        lists["im.vector.fake.recent"] = [];
        lists["im.vector.fake.direct"] = [];
        lists["m.lowpriority"] = [];
        lists["im.vector.fake.archived"] = [];

        const dmRoomMap = DMRoomMap.shared();
        MatrixClientPeg.get().getRooms().forEach((room) => {
            const me = room.getMember(MatrixClientPeg.get().credentials.userId);
            if (!me) return;

            // console.log("room = " + room.name + ", me.membership = " + me.membership +
            //             ", sender = " + me.events.member.getSender() +
            //             ", target = " + me.events.member.getStateKey() +
            //             ", prevMembership = " + me.events.member.getPrevContent().membership);

            if (me.membership == "invite") {
                lists["im.vector.fake.invite"].push(room);
            } else if (HIDE_CONFERENCE_CHANS && Rooms.isConfCallRoom(room, me, this.props.ConferenceHandler)) {
                // skip past this room & don't put it in any lists
            } else if (me.membership == "join" || me.membership === "ban" ||
                     (me.membership === "leave" && me.events.member.getSender() !== me.events.member.getStateKey())) {
                // Used to split rooms via tags
                const tagNames = Object.keys(room.tags);

                // Apply TagPanel filtering, derived from FilterStore
                if (!this.isRoomInSelectedTags(room)) {
                    return;
                }

                if (tagNames.length) {
                    for (let i = 0; i < tagNames.length; i++) {
                        const tagName = tagNames[i];
                        lists[tagName] = lists[tagName] || [];
                        lists[tagName].push(room);
                    }
                } else if (dmRoomMap.getUserIdForRoomId(room.roomId)) {
                    // "Direct Message" rooms (that we're still in and that aren't otherwise tagged)
                    lists["im.vector.fake.direct"].push(room);
                } else {
                    lists["im.vector.fake.recent"].push(room);
                }
            } else if (me.membership === "leave") {
                lists["im.vector.fake.archived"].push(room);
            } else {
                console.error("unrecognised membership: " + me.membership + " - this should never happen");
            }
        });

        // we actually apply the sorting to this when receiving the prop in RoomSubLists.

        // we'll need this when we get to iterating through lists programatically - e.g. ctrl-shift-up/down
/*
        this.listOrder = [
            "im.vector.fake.invite",
            "m.favourite",
            "im.vector.fake.recent",
            "im.vector.fake.direct",
            Object.keys(otherTagNames).filter(tagName=>{
                return (!tagName.match(/^m\.(favourite|lowpriority)$/));
            }).sort(),
            "m.lowpriority",
            "im.vector.fake.archived"
        ];
*/

        return lists;
    },

    _getScrollNode: function() {
        if (!this.mounted) return null;
        const panel = ReactDOM.findDOMNode(this);
        if (!panel) return null;

        if (panel.classList.contains('gm-prevented')) {
            return panel;
        } else {
            return panel.children[2]; // XXX: Fragile!
        }
    },

    _whenScrolling: function(e) {
        this._hideTooltip(e);
        this._repositionIncomingCallBox(e, false);
        this._updateStickyHeaders(false);
    },

    _hideTooltip: function(e) {
        // Hide tooltip when scrolling, as we'll no longer be over the one we were on
        if (this.tooltip && this.tooltip.style.display !== "none") {
            this.tooltip.style.display = "none";
        }
    },

    _repositionIncomingCallBox: function(e, firstTime) {
        const incomingCallBox = document.getElementById("incomingCallBox");
        if (incomingCallBox && incomingCallBox.parentElement) {
            const scrollArea = this._getScrollNode();
            if (!scrollArea) return;
            // Use the offset of the top of the scroll area from the window
            // as this is used to calculate the CSS fixed top position for the stickies
            const scrollAreaOffset = scrollArea.getBoundingClientRect().top + window.pageYOffset;
            // Use the offset of the top of the component from the window
            // as this is used to calculate the CSS fixed top position for the stickies
            const scrollAreaHeight = ReactDOM.findDOMNode(this).getBoundingClientRect().height;

            let top = (incomingCallBox.parentElement.getBoundingClientRect().top + window.pageYOffset);
            // Make sure we don't go too far up, if the headers aren't sticky
            top = (top < scrollAreaOffset) ? scrollAreaOffset : top;
            // make sure we don't go too far down, if the headers aren't sticky
            const bottomMargin = scrollAreaOffset + (scrollAreaHeight - 45);
            top = (top > bottomMargin) ? bottomMargin : top;

            incomingCallBox.style.top = top + "px";
            incomingCallBox.style.left = scrollArea.offsetLeft + scrollArea.offsetWidth + 12 + "px";
        }
    },

    // Doing the sticky headers as raw DOM, for speed, as it gets very stuttery if done
    // properly through React
    _initAndPositionStickyHeaders: function(initialise, scrollToPosition) {
        const scrollArea = this._getScrollNode();
        if (!scrollArea) return;
        // Use the offset of the top of the scroll area from the window
        // as this is used to calculate the CSS fixed top position for the stickies
        const scrollAreaOffset = scrollArea.getBoundingClientRect().top + window.pageYOffset;
        // Use the offset of the top of the componet from the window
        // as this is used to calculate the CSS fixed top position for the stickies
        const scrollAreaHeight = ReactDOM.findDOMNode(this).getBoundingClientRect().height;

        if (initialise) {
            // Get a collection of sticky header containers references
            this.stickies = document.getElementsByClassName("mx_RoomSubList_labelContainer");

            if (!this.stickies.length) return;

            // Make sure there is sufficient space to do sticky headers: 120px plus all the sticky headers
            this.scrollAreaSufficient = (120 + (this.stickies[0].getBoundingClientRect().height * this.stickies.length)) < scrollAreaHeight;

            // Initialise the sticky headers
            if (typeof this.stickies === "object" && this.stickies.length > 0) {
                // Initialise the sticky headers
                Array.prototype.forEach.call(this.stickies, function(sticky, i) {
                    // Save the positions of all the stickies within scroll area.
                    // These positions are relative to the LHS Panel top
                    sticky.dataset.originalPosition = sticky.offsetTop - scrollArea.offsetTop;

                    // Save and set the sticky heights
                    const originalHeight = sticky.getBoundingClientRect().height;
                    sticky.dataset.originalHeight = originalHeight;
                    sticky.style.height = originalHeight;

                    return sticky;
                });
            }
        }

        const self = this;
        let scrollStuckOffset = 0;
        // Scroll to the passed in position, i.e. a header was clicked and in a scroll to state
        // rather than a collapsable one (see RoomSubList.isCollapsableOnClick method for details)
        if (scrollToPosition !== undefined) {
            scrollArea.scrollTop = scrollToPosition;
        }
        // Stick headers to top and bottom, or free them
        Array.prototype.forEach.call(this.stickies, function(sticky, i, stickyWrappers) {
            const stickyPosition = sticky.dataset.originalPosition;
            const stickyHeight = sticky.dataset.originalHeight;
            const stickyHeader = sticky.childNodes[0];
            const topStuckHeight = stickyHeight * i;
            const bottomStuckHeight = stickyHeight * (stickyWrappers.length - i);

            if (self.scrollAreaSufficient && stickyPosition < (scrollArea.scrollTop + topStuckHeight)) {
                // Top stickies
                sticky.dataset.stuck = "top";
                stickyHeader.classList.add("mx_RoomSubList_fixed");
                stickyHeader.style.top = scrollAreaOffset + topStuckHeight + "px";
                // If stuck at top adjust the scroll back down to take account of all the stuck headers
                if (scrollToPosition !== undefined && stickyPosition === scrollToPosition) {
                    scrollStuckOffset = topStuckHeight;
                }
            } else if (self.scrollAreaSufficient && stickyPosition > ((scrollArea.scrollTop + scrollAreaHeight) - bottomStuckHeight)) {
                /// Bottom stickies
                sticky.dataset.stuck = "bottom";
                stickyHeader.classList.add("mx_RoomSubList_fixed");
                stickyHeader.style.top = (scrollAreaOffset + scrollAreaHeight) - bottomStuckHeight + "px";
            } else {
                // Not sticky
                sticky.dataset.stuck = "none";
                stickyHeader.classList.remove("mx_RoomSubList_fixed");
                stickyHeader.style.top = null;
            }
        });
        // Adjust the scroll to take account of top stuck headers
        if (scrollToPosition !== undefined) {
            scrollArea.scrollTop -= scrollStuckOffset;
        }
    },

    _updateStickyHeaders: function(initialise, scrollToPosition) {
        const self = this;

        if (initialise) {
            // Useing setTimeout to ensure that the code is run after the painting
            // of the newly rendered object as using requestAnimationFrame caused
            // artefacts to appear on screen briefly
            window.setTimeout(function() {
                self._initAndPositionStickyHeaders(initialise, scrollToPosition);
            });
        } else {
            this._initAndPositionStickyHeaders(initialise, scrollToPosition);
        }
    },

    onShowMoreRooms: function() {
        // kick gemini in the balls to get it to wake up
        // XXX: uuuuuuugh.
        this.refs.gemscroll.forceUpdate();
    },

    _getEmptyContent: function(section) {
        if (this.state.selectedTags.length > 0) {
            return null;
        }

        const RoomDropTarget = sdk.getComponent('rooms.RoomDropTarget');

        if (this.props.collapsed) {
            return <RoomDropTarget label="" />;
        }

        const StartChatButton = sdk.getComponent('elements.StartChatButton');
        const RoomDirectoryButton = sdk.getComponent('elements.RoomDirectoryButton');
        const CreateRoomButton = sdk.getComponent('elements.CreateRoomButton');

        switch (section) {
            case 'im.vector.fake.direct':
                return <div className="mx_RoomList_emptySubListTip">
                    { _t(
                        "Press <StartChatButton> to start a chat with someone",
                        {},
                        { 'StartChatButton': <StartChatButton size="16" callout={true} /> },
                    ) }
                </div>;
            case 'im.vector.fake.recent':
                return <div className="mx_RoomList_emptySubListTip">
                    { _t(
                        "You're not in any rooms yet! Press <CreateRoomButton> to make a room or"+
                        " <RoomDirectoryButton> to browse the directory",
                        {},
                        {
                            'CreateRoomButton': <CreateRoomButton size="16" callout={true} />,
                            'RoomDirectoryButton': <RoomDirectoryButton size="16" callout={true} />,
                        },
                    ) }
                </div>;
        }

        // We don't want to display drop targets if there are no room tiles to drag'n'drop
        if (this.state.totalRoomCount === 0) {
            return null;
        }

        const labelText = phraseForSection(section);

        return <RoomDropTarget label={labelText} />;
    },

    _getHeaderItems: function(section) {
        const StartChatButton = sdk.getComponent('elements.StartChatButton');
        const RoomDirectoryButton = sdk.getComponent('elements.RoomDirectoryButton');
        const CreateRoomButton = sdk.getComponent('elements.CreateRoomButton');
        switch (section) {
            case 'im.vector.fake.direct':
                return <span className="mx_RoomList_headerButtons">
                    <StartChatButton size="16" />
                </span>;
            case 'im.vector.fake.recent':
                return <span className="mx_RoomList_headerButtons">
                    <RoomDirectoryButton size="16" />
                    <CreateRoomButton size="16" />
                </span>;
        }
    },

    _makeGroupInviteTiles() {
        const ret = [];

        const GroupInviteTile = sdk.getComponent('groups.GroupInviteTile');
        for (const group of MatrixClientPeg.get().getGroups()) {
            if (group.myMembership !== 'invite') continue;

            ret.push(<GroupInviteTile key={group.groupId} group={group} />);
        }

        return ret;
    },

    render: function() {
        const RoomSubList = sdk.getComponent('structures.RoomSubList');

        const self = this;
        return (
            <GeminiScrollbar className="mx_RoomList_scrollbar"
                 autoshow={true} onScroll={self._whenScrolling} ref="gemscroll">
            <div className="mx_RoomList">
                <RoomSubList list={[]}
                             extraTiles={this._makeGroupInviteTiles()}
                             label={_t('Community Invites')}
                             editable={false}
                             order="recent"
                             isInvite={true}
                             collapsed={self.props.collapsed}
                             searchFilter={self.props.searchFilter}
                             onHeaderClick={self.onSubListHeaderClick}
                             onShowMoreRooms={self.onShowMoreRooms}
                />

                <RoomSubList list={self.state.lists['im.vector.fake.invite']}
                             label={_t('Invites')}
                             editable={false}
                             order="recent"
                             isInvite={true}
                             selectedRoom={self.props.selectedRoom}
                             incomingCall={self.state.incomingCall}
                             collapsed={self.props.collapsed}
                             searchFilter={self.props.searchFilter}
                             onHeaderClick={self.onSubListHeaderClick}
                             onShowMoreRooms={self.onShowMoreRooms}
                />

                <RoomSubList list={self.state.lists['m.favourite']}
                             label={_t('Favourites')}
                             tagName="m.favourite"
                             emptyContent={this._getEmptyContent('m.favourite')}
                             editable={true}
                             order="manual"
                             selectedRoom={self.props.selectedRoom}
                             incomingCall={self.state.incomingCall}
                             collapsed={self.props.collapsed}
                             searchFilter={self.props.searchFilter}
                             onHeaderClick={self.onSubListHeaderClick}
                             onShowMoreRooms={self.onShowMoreRooms} />

                <RoomSubList list={self.state.lists['im.vector.fake.direct']}
                             label={_t('People')}
                             tagName="im.vector.fake.direct"
                             emptyContent={this._getEmptyContent('im.vector.fake.direct')}
                             headerItems={this._getHeaderItems('im.vector.fake.direct')}
                             editable={true}
                             order="recent"
                             selectedRoom={self.props.selectedRoom}
                             incomingCall={self.state.incomingCall}
                             collapsed={self.props.collapsed}
                             alwaysShowHeader={true}
                             searchFilter={self.props.searchFilter}
                             onHeaderClick={self.onSubListHeaderClick}
                             onShowMoreRooms={self.onShowMoreRooms} />

                <RoomSubList list={self.state.lists['im.vector.fake.recent']}
                             label={_t('Rooms')}
                             editable={true}
                             emptyContent={this._getEmptyContent('im.vector.fake.recent')}
                             headerItems={this._getHeaderItems('im.vector.fake.recent')}
                             order="recent"
                             selectedRoom={self.props.selectedRoom}
                             incomingCall={self.state.incomingCall}
                             collapsed={self.props.collapsed}
                             searchFilter={self.props.searchFilter}
                             onHeaderClick={self.onSubListHeaderClick}
                             onShowMoreRooms={self.onShowMoreRooms} />

                { Object.keys(self.state.lists).map((tagName) => {
                    if (!tagName.match(/^(m\.(favourite|lowpriority)|im\.vector\.fake\.(invite|recent|direct|archived))$/)) {
                        return <RoomSubList list={self.state.lists[tagName]}
                             key={tagName}
                             label={tagName}
                             tagName={tagName}
                             emptyContent={this._getEmptyContent(tagName)}
                             editable={true}
                             order="manual"
                             selectedRoom={self.props.selectedRoom}
                             incomingCall={self.state.incomingCall}
                             collapsed={self.props.collapsed}
                             searchFilter={self.props.searchFilter}
                             onHeaderClick={self.onSubListHeaderClick}
                             onShowMoreRooms={self.onShowMoreRooms} />;
                    }
                }) }

                <RoomSubList list={self.state.lists['m.lowpriority']}
                             label={_t('Low priority')}
                             tagName="m.lowpriority"
                             emptyContent={this._getEmptyContent('m.lowpriority')}
                             editable={true}
                             order="recent"
                             selectedRoom={self.props.selectedRoom}
                             incomingCall={self.state.incomingCall}
                             collapsed={self.props.collapsed}
                             searchFilter={self.props.searchFilter}
                             onHeaderClick={self.onSubListHeaderClick}
                             onShowMoreRooms={self.onShowMoreRooms} />

                <RoomSubList list={self.state.lists['im.vector.fake.archived']}
                             label={_t('Historical')}
                             editable={false}
                             order="recent"
                             selectedRoom={self.props.selectedRoom}
                             collapsed={self.props.collapsed}
                             alwaysShowHeader={true}
                             startAsHidden={true}
                             showSpinner={self.state.isLoadingLeftRooms}
                             onHeaderClick= {self.onArchivedHeaderClick}
                             incomingCall={self.state.incomingCall}
                             searchFilter={self.props.searchFilter}
                             onShowMoreRooms={self.onShowMoreRooms} />
            </div>
            </GeminiScrollbar>
        );
    },
});
