# Soultee Discovery and Connection System

This backend separates four concerns:

1. Visibility
2. Presence
3. Request persistence
4. Accepted realtime communication

## Architecture

### Visibility

- All Soultee profiles are stored in `Soultee`.
- Student dashboard fetches all Soultees from `GET /api/soultees`.
- Passing `studentUid` enriches each Soultee with the current relationship state for that student.
- Visibility is independent from online/offline presence.

### Presence

- Presence is managed only through Socket.io events in `sockets/realtimeServer.js`.
- Soultee presence is persisted as `online`, `busy`, or `offline` on the `Soultee.status` field for listing and indicators.
- Runtime presence is reset to `offline` on server startup so stale status is not shown after crashes or redeploys.
- Student presence is emitted in realtime but is not part of Soultee discovery.

### Request System

- Persistent request and accepted-connection state is stored in `StudentSoulteeLink`.
- `pending` means request sent.
- `active` means request accepted and chat/call room available.
- `declined` means rejected.
- `ended` means a previously accepted connection was closed.

### Realtime Communication

- Once a request is accepted, `StudentSoulteeLink._id` becomes the dedicated room id.
- Chat messages are stored in `Message` and delivered through Socket.io.
- Audio/video calls use Socket.io only for signaling; media transport is WebRTC peer-to-peer.
- Notifications are stored in `Notification` and emitted in realtime through personal socket rooms.

## Collections

### Soultee

- `firebaseUid`
- `name`
- `status`
- profile metadata such as specialization, bio, profileImage, languages

### StudentSoulteeLink

- `studentFirebaseUid`
- `studentName`
- `soulteeFirebaseUid`
- `status`: `pending | active | declined | ended`
- `requestMessage`
- `requestedAt`
- `acceptedAt`
- `endedAt`

### Message

- `roomId`
- `senderId`
- `senderName`
- `senderRole`
- `text`
- `type`
- timestamps

### Notification

- `recipientUid`
- `recipientRole`
- `type`
- `title`
- `body`
- `data`
- `read`

## REST APIs

### Student dashboard

#### Get all Soultees

`GET /api/soultees?studentUid=<studentUid>`

Returns all Soultees, including offline ones, enriched with:

- `requestStatus`: `none | pending | accepted | rejected`
- `connectionStatus`: raw backend state `none | pending | active | declined | ended`
- `requestId`
- `requestedAt`
- `acceptedAt`
- `roomId` when accepted

#### Send request

`POST /api/soultee-dashboard/request`

Body:

```json
{
  "studentFirebaseUid": "student_uid",
  "studentName": "Student Name",
  "soulteeFirebaseUid": "soultee_uid",
  "requestMessage": "I'd like to connect"
}
```

#### Get my request states

`GET /api/soultee-dashboard/my-requests/:studentUid`

#### Get accepted connections

`GET /api/soultee-dashboard/connections/:studentUid`

Returns active connections with `roomId` and Soultee profile info.

### Soultee dashboard

#### Get pending requests

`GET /api/soultee-dashboard/:soulteeUid/requests`

#### Accept request

`PATCH /api/soultee-dashboard/:soulteeUid/requests/:studentUid/accept`

#### Reject request

`PATCH /api/soultee-dashboard/:soulteeUid/requests/:studentUid/decline`

#### Get accepted students

`GET /api/soultee-dashboard/:soulteeUid/students`

## Socket.io events

### Presence events from clients

- `student_go_online` `{ uid, name }`
- `soultee_go_online` `{ uid, name }`
- `soultee_set_busy` `{ uid }`
- `soultee_go_offline` `{ uid }`

### Presence events from server

- `student_status_changed` `{ uid, status }`
- `soultee_status_changed` `{ uid, status }`

### Request and notification events from server

- `new_connection_request`
- `connection_accepted`
- `connection_declined`
- `connection_request_updated`
- `new_notification`

### Room lifecycle

- `join_room` `{ roomId, userId, userName, userRole }`
- `room_joined`
- `socket_error`

Only users belonging to an accepted `StudentSoulteeLink` can join the room.

### Chat events

- `send_message`
- `new_message`
- `typing`
- `user_typing`
- `stop_typing`
- `user_stop_typing`

### Call signaling events

- `call_offer`
- `call_answer`
- `ice_candidate`
- `reject_call`
- `call_rejected`
- `end_call`
- `call_ended`

## Frontend flow

### Student

1. Fetch all Soultees with `GET /api/soultees?studentUid=<uid>`.
2. Render all Soultees, not only online ones.
3. Show presence indicator from `status`.
4. Show `Send Request` when `requestStatus` is `none` or `rejected`.
5. Listen for `connection_accepted`, `connection_declined`, `connection_request_updated`, and `new_notification`.
6. When accepted, use `roomId` for chat and call screens.

### Soultee

1. On login, fetch `GET /api/soultee-dashboard/:soulteeUid/requests`.
2. Also listen for `new_connection_request` for realtime arrivals.
3. Accept or reject with the PATCH routes.
4. Use `GET /api/soultee-dashboard/:soulteeUid/students` for accepted connections.

## Scaling notes

- `StudentSoulteeLink` and `Message` include indexes for request lists and room history.
- Personal socket rooms are role-scoped: `student:<uid>` and `soultee:<uid>`.
- Room authorization is checked against MongoDB before joining chat/call rooms.
- For horizontal scaling, the next backend step is adding a shared Socket.io adapter such as Redis.
- For production security, authenticate socket users instead of trusting raw client-supplied ids.