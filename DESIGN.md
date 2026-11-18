# CoShop

## Audit and sitemap

CoShop has one public shell. Hosts start at / and create a room. Guests arrive through /?room=… and join with a display name. Returning shoppers resume that room. Catalog, product detail, activity, bag, invite, Peek and Haul are room views and overlays. Status covers unavailable rooms and connection recovery. Keep those URLs, guest links, storage, realtime commands and checkout callbacks.

The host needs one clear starting action. Guests need to identify their room and enter with minimal friction. Active shoppers need the collection first, then a persistent way to reach their group and bag. The duplicate homepage catalog action, bag on the left, late desktop panel breakpoint, and cramped recap rows compete with those jobs.

| Surface                    | Primary action                 | Section order                                                           |
| -------------------------- | ------------------------------ | ----------------------------------------------------------------------- |
| Home /                     | Start a shopping room          | Brand navigation, headline and ASCII artwork, three-step guide, footer  |
| Room setup, same shell     | Make room or join              | Room identity, catalog choice for hosts, name and avatar, submit        |
| Shared room /?room=…       | Browse and choose a product    | Room identity and invite, presence and shared actions, filters, catalog |
| Product detail, room state | Add selected variant           | Back, image, name and price, variant, availability and share            |
| Around the room            | Open a find or join discussion | Dock heading, tabs, activity. Use a modal drawer on narrow screens      |
| Bag and Haul               | Review picks or subtotal       | Heading, item rows, subtotal, checkout or most shared                   |
| Room status                | Retry or return home           | Status and recovery action                                              |

## Visual system

Use local Jakarta for headings and body and monospace for ASCII. Headings use responsive sizes with tighter tracking and body text stays at 14–16 px. Warm paper #f8f7f4, near-black greens #242820, pale sage #edf0e5 and a forest bag action #315741. Use consistent responsive gutters of 16–64 px, a 4/8/16/24/40/64 px spacing scale and 8–14 px corners. Use two columns in the hero, one on narrow screens. Catalog stays responsive with consistent photo frames. The ASCII artwork is the landing visual. Real product images lead the catalog, product and recap.

Interactive controls have visible focus, selected and disabled states. Keep 44 px primary targets while reducing decorative avatar and reaction glyphs. Use a deliberate inline error or status when room operations fail.

## Motion

Fine pointer hover changes button color and border in 140 ms. Image hover uses a mild scale inside the frame over 220 ms. Press reacts immediately. Room activity drawers enter horizontally. Peek and other centered dialogs use 10 px vertical travel and a fade. Modal fade is 180 ms and movement 220 ms with cubic-bezier(.22,.7,.25,1). Keep the modal active through dismissal and restore focus. The homepage guide reveals once on viewport intersection with an 8 px move and a 280 ms fade. Without IntersectionObserver it is immediately visible. Reduced motion removes movement and transitions and leaves every section visible. Never replay entrance motion on search or a peer event.

References: Ramp's desktop scroll for section rhythm, UI by Made Good Designs for product hierarchy and order summary grouping (https://madegooddesigns.com/inspiration/ui/ecommerce-website-web-editorial-8f2623f5d3f4 and https://madegooddesigns.com/inspiration/ui/checkout-web-editorial-c44aaa43a7d0).

## Verification

The production build and all 69 automated tests passed. Chrome checks covered the home navigation and setup form, keyboard room creation, empty search and reset, room activity, Bag and simulated Haul at desktop and 390 px. The mobile check emulated reduced motion and confirmed that drawer transitions resolved to zero seconds. A separate 1024 px host and 320 px guest completed an invitation, shared the Tan watch, opened the exact Peek, and exercised invalid-invite recovery. The Shopify path was covered by the existing fixtures. Live Shopify checkout and physical assistive technology were outside these runs.

The live catalog entry is shown in room setup with a configuration requirement. The service reports an unavailable catalog through the existing form error.