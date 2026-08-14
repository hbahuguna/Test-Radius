# QueryFirst fixture site

Static fixture pages used for end-to-end UI testing with QueryFirst. Served by
`fixture/server.ts` (zero-dependency Node static server).

## Run

```sh
pnpm fixture            # serves at http://localhost:3123
PORT=8080 pnpm fixture  # serve on another port
```

Add `?redesign=1` to any page URL to toggle the redesign mode (see below).

## URLs

| URL                          | Page              |
| ---------------------------- | ----------------- |
| `http://localhost:3123/`     | index (link hub)  |
| `http://localhost:3123/login`| Login form        |
| `http://localhost:3123/signup`| Sign-up form     |
| `http://localhost:3123/pricing-waitlist` | Pricing + waitlist |
| `http://localhost:3123/dynamic` | Late-appearing elements + dynamic controls |

Query strings are ignored by the server, so `?redesign=1` never affects routing.

## Stable elements

Data test IDs are stable targets for selectors. They are not attached to the
form submit/`change` handling, which uses element `id`s.

### `/login`

| testid           | element      | notes                    |
| ---------------- | ------------ | ------------------------ |
| `login-email`    | input        |                          |
| `login-password` | input        |                          |
| `login-submit`   | button       | resolves via `#login-form` submit |
| `login-result`   | output `p`   | filled by JS             |

### `/signup`

| testid           | element      | notes                    |
| ---------------- | ------------ | ------------------------ |
| `signup-name`    | input        |                          |
| `signup-email`   | input        |                          |
| `signup-password`| input        |                          |
| `signup-submit`  | button       | resolves via `#signup-form` submit |
| `signup-result`  | output `p`   | filled by JS             |

### `/pricing-waitlist`

| testid          | element | notes                          |
| --------------- | ------- | ------------------------------ |
| `plan-card`     | `div`   | one of three, `.pricing-card`  |
| `plan-name`     | `h2`    | inside each plan card          |
| `plan-price`    | `p`     | inside each plan card          |
| `plan-desc`     | `p`     | inside each plan card          |
| `waitlist-email`| input   |                                |
| `waitlist-submit` | button | resolves via `#waitlist-form` submit |
| `waitlist-result` | output `p` | filled by JS              |

### `/dynamic`

| testid            | element | notes                         |
| ----------------- | ------- | ----------------------------- |
| `dynamic-status`  | `p`     | present from load             |
| `dynamic-clicked` | `p`     | hidden until button clicked   |
| `dynamic-appears` | button  | injected ~1.5 s after load    |
| `#appears-late`   | `div`   | `data-testid` added ~2.5 s after load |

## Redesign mode (`?redesign=1`)

`fixture/redesign.js` (loaded by every page) rewrites `data-testid`s to a new
naming scheme, moves the back-nav to the top of the card, and adds a
`Redesigned layout` banner. The choice persists in `sessionStorage`
(`qf-redesign`), so navigating between pages keeps the mode. Toggle back with
`?redesign=0`.

| default            | redesign               |
| ------------------ | ---------------------- |
| `login-email`      | `login-email-address`  |
| `login-password`   | `login-password-field` |
| `login-submit`     | `btn-sign-in`          |
| `login-result`     | `login-message`        |
| `signup-name`      | `signup-full-name`     |
| `signup-email`     | `signup-email-address` |
| `signup-password`  | `signup-password-field`|
| `signup-submit`    | `btn-create-account`   |
| `signup-result`    | `signup-message`       |
| `waitlist-email`   | `waitlist-email-address` |
| `waitlist-submit`  | `btn-join-waitlist`    |
| `waitlist-result`  | `waitlist-message`     |
| `plan-card`        | `pricing-plan`         |
| `plan-name`        | `pricing-plan-title`   |
| `plan-price`       | `pricing-plan-price`   |
| `plan-desc`        | `pricing-plan-desc`    |
| `dynamic-status`   | `dynamic-label`        |
| `dynamic-appears`  | `dynamic-reveal-btn`   |
| `dynamic-clicked`  | `dynamic-message`      |

In redesign mode the pages also add `body.redesign` (restyled cards/buttons via
`fixture/styles.css`) and a `redesign-banner` testid element.

## Functionality invariant

Both modes are functionally equivalent: all forms submit (with fake latency)
and update their result `p` via JS, and the redesign only changes presentation
and `data-testid` values.
