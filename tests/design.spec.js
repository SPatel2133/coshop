import { chromium, test, expect } from "@playwright/test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const base = process.env.COSHOP_TEST_URL || "http://127.0.0.1:4204";

async function room(page) {
  await page.goto(base);
  await page.getByRole("button", { name: "Start a shopping room" }).click();
  await page
    .getByRole("textbox", { name: "Name (required)" })
    .fill("Sam");
  await page.getByRole("button", { name: /Make room/ }).click();
  await expect(page.getByText("Connected", { exact: true })).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}

for (const [width, columns, gap] of [
  [360, 2, 12],
  [768, 3, 16],
  [1179, 3, 16],
  [1180, 3, 16],
  [1440, 4, 24],
]) {
  test(`catalog geometry and drawer at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await room(page);
    const grid = await page.locator(".react-grid").evaluate((node) => {
      const style = getComputedStyle(node);
      const media = node
        .querySelector(".product-media")
        .getBoundingClientRect();
      return {
        columns: style.gridTemplateColumns.split(" ").length,
        gap: parseFloat(style.columnGap),
        width: media.width,
        height: media.height,
        overflow: document.documentElement.scrollWidth > innerWidth,
      };
    });
    expect(grid).toMatchObject({ columns, gap, overflow: false });
    expect(grid.width / grid.height).toBeCloseTo(4 / 5, 2);
    if (process.env.COSHOP_EVIDENCE && [360, 1440].includes(width)) {
      await expect
        .poll(() =>
          page
            .locator("#products img")
            .first()
            .evaluate((img) => img.naturalWidth),
        )
        .toBeGreaterThan(0);
      await page.screenshot({
        path: process.env.COSHOP_EVIDENCE + `/room-${width}.png`,
      });
    }
    const opener = page.getByRole("button", { name: "Around the room" });
    await opener.focus();
    await page.keyboard.press("Enter");
    const drawer = page.getByRole("dialog", { name: "Around the room" });
    await expect(drawer).toBeVisible();
    expect(await drawer.evaluate((node) => node.matches(":modal"))).toBe(
      width < 1180,
    );
    const rect = await drawer.boundingBox();
    expect(Math.round(rect.width)).toBe(width === 360 ? 344 : 360);
    if (width >= 1180) {
      const search = await page
        .getByRole("searchbox", { name: "Search the collection" })
        .boundingBox();
      expect(search.x + search.width).toBeLessThanOrEqual(rect.x);
    }
    await expect(drawer.locator("pre")).toHaveCount(0);
    if (process.env.COSHOP_EVIDENCE && [360, 1440].includes(width)) {
      await expect
        .poll(() =>
          page
            .locator("#products img")
            .first()
            .evaluate((img) => img.naturalWidth),
        )
        .toBeGreaterThan(0);
      await expect(drawer).toHaveCSS("opacity", "1");
      await page.screenshot({
        path: process.env.COSHOP_EVIDENCE + `/drawer-${width}.png`,
      });
    }
    const invite = drawer.getByRole("button", { name: "Invite a friend" });
    await invite.click();
    await expect(
      page.getByRole("dialog", { name: "Invite your people" }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(invite).toBeFocused();
    await expect(drawer).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(drawer).toBeHidden();
    await expect(opener).toBeFocused();
  });
}

test("reduced motion, offline status, rejected clipboard and zero results", async ({
  page,
  context,
}) => {
  await page.setViewportSize({ width: 360, height: 780 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(() =>
    Object.defineProperty(navigator, "clipboard", {
      value: {
        writeText: async () => {
          throw new Error("Test clipboard denial");
        },
      },
    }),
  );
  await room(page);
  await page.getByRole("button", { name: "Around the room" }).click();
  const drawer = page.locator("#finds-drawer");
  expect(
    await drawer.evaluate((node) => getComputedStyle(node).transitionDuration),
  ).toBe("0s");
  await page.waitForTimeout(850);
  await drawer.getByRole("button", { name: "Invite a friend" }).click();
  await page.getByRole("button", { name: "Copy invite link" }).click();
  await expect(page.getByText("Copy the selected invite link.")).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "Invitation link" }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Audio", exact: true }).click();
  const search = page.getByRole("searchbox", { name: "Search the collection" });
  await search.fill("no matches here");
  await expect(page.getByText("0 products")).toBeVisible();
  await page.getByRole("button", { name: "Reset filters" }).click();
  await expect(search).toHaveValue("");
  await expect(
    page.getByRole("button", { name: "Everything" }),
  ).toHaveAttribute("aria-pressed", "true");
  await context.setOffline(true);
  await expect(page.getByText("Reconnecting…", { exact: true })).toBeVisible();
  await context.setOffline(false);
  await expect(page.getByText("Connected", { exact: true })).toBeVisible();
});
test("exact saved find, stable browsing, one connection and shared haul", async ({
  page,
  browser,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  let socketCount = 0;
  page.on("websocket", (socket) => {
    if (socket.url().endsWith("/socket")) socketCount++;
  });
  await page.addInitScript(() =>
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: async () => {} },
    }),
  );
  await room(page);
  await page.getByRole("button", { name: "Invite", exact: true }).click();
  await page.getByRole("button", { name: "Copy invite link" }).click();
  await expect(
    page.getByText("Copied. Drop it in your call chat."),
  ).toBeVisible();
  const link = await page
    .getByRole("textbox", { name: "Invitation link" })
    .inputValue();
  await page.keyboard.press("Escape");
  const friend = await browser.newContext();
  try {
    const maya = await friend.newPage();
    await maya.goto(link);
    await maya
      .getByRole("textbox", { name: "Name (required)" })
      .fill("Maya");
    await maya.getByRole("button", { name: /Join your people/ }).click();
    await expect(maya.getByText("Connected", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Audio", exact: true }).click();
    const search = page.getByRole("searchbox", {
      name: "Search the collection",
    });
    await search.fill("headphones");
    await page.getByRole("button", { name: "View Over-Ear Headphones" }).click();
    const variant = page.getByRole("combobox", { name: "Choose a variant" });
    await variant.selectOption({ label: "Black" });
    await variant.focus();
    const y = await page.evaluate(() => scrollY);

    await maya.getByRole("button", { name: "View Wristwatch" }).click();
    await maya
      .getByRole("combobox", { name: "Choose a variant" })
      .selectOption({ label: "Tan" });
    await maya.getByRole("button", { name: "Share find" }).click();
    await maya.getByRole("button", { name: /Back to the collection/ }).click();
    await maya.getByRole("button", { name: "View Backpack" }).click();
    await expect(page.getByText("Maya shared a find.")).toBeVisible();
    await expect(page.locator("#open-finds")).toHaveAccessibleName("Around the room, 1 unseen");
    await expect(variant).toBeFocused();
    expect(await page.evaluate(() => scrollY)).toBe(y);
    await expect(
      page.getByRole("button", { name: "Shared bag, 0 items" }),
    ).toBeVisible();
    await expect(variant.locator("option:checked")).toHaveText("Black");
    await page.getByRole("button", { name: /Back to the collection/ }).click();
    await expect(search).toHaveValue("headphones");
    await expect(
      page.getByRole("button", { name: "View Over-Ear Headphones" }),
    ).toBeFocused();

    await page.getByRole("button", { name: /Around the room/ }).click();
    const drawer = page.getByRole("dialog", { name: "Around the room" });
    await drawer
      .getByRole("button", { name: "Comment on Wristwatch · Tan" })
      .click();
    await drawer.getByRole("textbox").fill("Keep the exact variant");
    await drawer
      .getByRole("button", { name: "View find: Wristwatch · Tan" })
      .click();
    await page.keyboard.press("Escape");
    await expect(drawer.getByRole("textbox")).toHaveValue(
      "Keep the exact variant",
    );
    await page.keyboard.press("Escape");
    await expect(drawer).toBeHidden();

    await page.getByRole("button", { name: "View Over-Ear Headphones" }).click();
    await page.getByRole("button", { name: "Add to bag" }).click();
    await expect(
      maya.getByRole("button", { name: "Shared bag, 1 item" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Shared bag, 1 item" }).click();
    await page
      .getByRole("button", { name: "Demo completion · simulated" })
      .click();
    await expect(page.getByRole("dialog", { name: "The haul." })).toBeVisible();
    await maya
      .getByRole("button", { name: "See the haul", exact: true })
      .click();
    await expect(maya.getByRole("dialog", { name: "The haul." })).toBeVisible();
    expect(socketCount).toBe(1);
  } finally {
    await friend.close();
  }
});

test("short drawer, failed product photos and 200% reflow", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.route(/images\.unsplash\.com|\/assets\/catalog-/, (route) => route.abort());
  await room(page);
  await expect(
    page.locator("#products").getByText("Image unavailable").first(),
  ).toBeVisible();
  const measure = () =>
    page
      .locator(".react-grid .product-media")
      .first()
      .evaluate((node) => {
        const rect = node.getBoundingClientRect();
        return {
          ratio: rect.width / rect.height,
          overflow: document.documentElement.scrollWidth > innerWidth,
        };
      });
  expect(await measure()).toMatchObject({ overflow: false });
  expect((await measure()).ratio).toBeCloseTo(4 / 5, 2);
  // A 720 CSS-pixel viewport exercises the reflow space available at 200% on 1440.
  await page.setViewportSize({ width: 720, height: 450 });
  expect((await measure()).overflow).toBe(false);
  const opener = page.getByRole("button", { name: "Around the room" });
  await opener.click();
  const drawer = page.getByRole("dialog", { name: "Around the room" });
  const close = drawer.getByRole("button", { name: "Close room panel" });
  await expect(close).toBeFocused();
  await expect(drawer).toHaveCSS("opacity", "1");
  await page.keyboard.press("Escape");
  const exit = await page.locator("#finds-drawer").evaluate((node) => ({
    open: node.open,
    duration: getComputedStyle(node).transitionDuration,
    easing: getComputedStyle(node).transitionTimingFunction,
  }));
  expect(exit.open).toBe(true);
  expect(exit.duration).toContain("0.16s");
  expect(exit.easing).toContain("cubic-bezier(0.4, 0, 1, 1)");
  await expect(drawer).toBeHidden();
  await expect(opener).toBeFocused();
});

test("native 200% Chrome zoom keeps the room and drawer usable", async () => {
  const profile = await mkdtemp(join(tmpdir(), "coshop-browser-zoom-"));
  const context = await chromium.launchPersistentContext(profile, {
    channel: "chromium",
    viewport: { width: 1440, height: 900 },
  });
  try {
    const page = context.pages()[0];
    await page.goto("chrome://settings/appearance");
    await page
      .locator("select")
      .filter({
        has: page.locator("option").filter({ hasText: "200%" }),
      })
      .selectOption({ label: "200%" });
    await room(page);
    expect(
      await page.evaluate(() => ({
        width: innerWidth,
        dpr: devicePixelRatio,
        overflow: document.documentElement.scrollWidth > innerWidth,
      })),
    ).toEqual({ width: 720, dpr: 2, overflow: false });
    const opener = page.getByRole("button", { name: "Around the room" });
    await opener.focus();
    await page.keyboard.press("Enter");
    await expect(
      page.getByRole("button", { name: "Close room panel" }),
    ).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(opener).toBeFocused();
  } finally {
    await context.close();
  }
});

test("desktop motion remains dismissible under 4x CPU throttling", async ({
  page,
  context,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await room(page);
  const protocol = await context.newCDPSession(page);
  await protocol.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  try {
    const bag = page.getByRole("button", { name: "Shared bag, 0 items" });
    const drawer = page.locator("#bag-drawer");
    await bag.focus();
    await page.keyboard.press("Enter");
    await page.keyboard.press("Escape");
    await expect(drawer).toBeHidden();
    await expect(bag).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(drawer).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Close shared bag" }),
    ).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(bag).toBeFocused();
  } finally {
    await protocol.send("Emulation.setCPUThrottlingRate", { rate: 1 });
    await protocol.detach();
  }
});

test("long shared bag remains usable in a short mobile viewport", async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 450 });
  await room(page);
  let quantity = 0;
  for (const name of [
    "Backpack",
    "Over-Ear Headphones",
    "Reading Chair",
    "Mirrorless Camera",
    "Wristwatch",
    "Hat",
  ]) {
    await page
      .getByRole("button", { name: "View " + name, exact: true })
      .click();
    await page.getByRole("button", { name: "Add to bag", exact: true }).click();
    quantity++;
    await expect(
      page.getByRole("button", {
        name: `Shared bag, ${quantity} ${quantity === 1 ? "item" : "items"}`,
      }),
    ).toBeVisible();
    await page.getByRole("button", { name: /Back to the collection/ }).click();
  }
  await page.getByRole("button", { name: "Shared bag, 6 items" }).click();
  const dialog = page.getByRole("dialog", { name: "Shared bag" });
  expect(await dialog.locator("#bag-items > li").count()).toBe(6);
  const recap = dialog.getByRole("button", {
    name: "Demo completion · simulated",
  });
  await recap.scrollIntoViewIfNeeded();
  await expect(recap).toBeInViewport();
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", { name: "Shared bag, 6 items" }),
  ).toBeFocused();
});

test("required participant names block requests and trim valid Unicode names", async ({ page, browser }) => {
  const guest = await browser.newContext();
  try {
    const guestPage = await guest.newPage();
    await page.goto(base);
    await page.getByRole("button", { name: "Start a shopping room" }).click();

    async function enter(target, action, name) {
      const input = target.getByRole("textbox", { name: "Name (required)" });
      const submit = target.getByRole("button", { name: action });
      const submitted = [];
      target.on("request", (request) => {
        if (request.method() === "POST" &&
            /\/api\/rooms(?:\/[^/]+\/join)?$/.test(request.url())) {
          submitted.push(request.postDataJSON().name);
        }
      });
      await submit.click();
      await expect(input).toBeFocused();
      await expect(input).toHaveAccessibleDescription("Enter your name.");
      await input.fill("   ");
      await input.press("Enter");
      await expect(input).toBeFocused();
      await expect(input).toHaveAttribute("aria-invalid", "true");
      expect(submitted).toEqual([]);
      await input.fill("  " + name + "  ");
      await expect(input).not.toHaveAttribute("aria-invalid");
      await input.press("Enter");
      await expect(target.getByText("Connected", { exact: true })).toBeVisible();
      expect(submitted).toEqual([name]);
    }

    await enter(page, /Make room/, "Élodie");
    await page.getByRole("button", { name: "Invite", exact: true }).click();
    const link = await page.getByRole("dialog").locator("input").inputValue();
    await guestPage.goto(link);
    await enter(guestPage, /Join your people/, "Zoë");
  } finally {
    await guest.close();
  }
});


test("landing canvas animates, pauses, and respects reduced motion", async ({ page }) => {
  for (const width of [360, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(base);
    const title = page.getByRole("heading", { name: "CoShop", exact: true });
    await expect(title).toBeVisible();
    await expect(page.getByText("Find it. Share it. Shop together.", { exact: true })).toBeVisible();
    const canvas = page.locator(".landing-ambient");
    const image = () => canvas.evaluate((node) => node.toDataURL());
    await expect(canvas).toHaveCSS("pointer-events", "none");
    const first = await image();
    await expect.poll(image).not.toBe(first);
    const toggle = page.getByRole("button", { name: "Background motion" });
    await toggle.click();
    await expect(toggle).toHaveText("Motion off");
    const stopped = await image();
    await page.waitForTimeout(150);
    expect(await image()).toBe(stopped);
    if (process.env.COSHOP_EVIDENCE)
      await page.screenshot({ path: process.env.COSHOP_EVIDENCE + `/landing-${width}.png` });
    await toggle.click();
  }
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(page.getByRole("button", { name: "Background motion" })).toBeDisabled();
  const stopped = await page.locator(".landing-ambient").evaluate((node) => node.toDataURL());
  await page.waitForTimeout(150);
  expect(await page.locator(".landing-ambient").evaluate((node) => node.toDataURL())).toBe(stopped);
});

test("unconfigured Shopify preserves the form and lets the shopper choose sample", async ({ page }) => {
  await page.goto(base);
  await page.getByRole("button", { name: "Start a shopping room" }).click();
  const roomName = page.getByRole("textbox", { name: "Room Name (Optional)" });
  const name = page.getByRole("textbox", { name: "Name (required)" });
  const avatar = page.getByRole("radio", { name: "sky avatar" });
  const catalog = page.getByRole("combobox", { name: "Catalog" });
  await roomName.fill("Friday Finds");
  await name.fill("Sam");
  await avatar.check();
  await catalog.selectOption("shopify");
  const submit = page.getByRole("button", { name: /Make room/ });
  await submit.click();
  await expect(page.getByRole("alert")).toContainText("No Shopify store is configured");
  await expect(roomName).toHaveValue("Friday Finds");
  await expect(name).toHaveValue("Sam");
  await expect(avatar).toBeChecked();
  await expect(catalog).toHaveValue("shopify");
  await catalog.selectOption("sample");
  await submit.click();
  await expect(page.getByRole("heading", { name: "Friday Finds" })).toBeVisible();
  await expect(page.locator("#products h3").nth(3)).toHaveText("Mirrorless Camera");
});

test("three shoppers converge on exact finds across repeats, refresh, and explicit add", async ({ browser, page }) => {
  const contexts = await Promise.all([browser.newContext(), browser.newContext()]);
  const [maya, priya] = await Promise.all(contexts.map((context) => context.newPage()));
  const pages = [page, maya, priya];
  const panel = (shopper) => shopper.getByRole("dialog", { name: "Around the room" });
  const cards = (shopper) => panel(shopper).locator("[data-find]");
  const variant = (shopper) => shopper.getByRole("combobox", { name: "Choose a variant" });
  const headphones = (shopper) => shopper.getByRole("button", { name: "View Over-Ear Headphones" });
  try {
    for (const shopper of pages) await shopper.setViewportSize({ width: 1440, height: 900 });
    await room(page);
    await page.getByRole("button", { name: "Invite", exact: true }).click();
    const link = await page.getByRole("textbox", { name: "Invitation link" }).inputValue();
    await page.keyboard.press("Escape");
    await Promise.all([[maya, "Maya"], [priya, "Priya"]].map(async ([shopper, name]) => {
      await shopper.goto(link);
      await shopper.getByRole("textbox", { name: "Name (required)" }).fill(name);
      await shopper.getByRole("button", { name: /Join your people/ }).click();
      await expect(shopper.getByText("Connected", { exact: true })).toBeVisible();
    }));
    const query = page.getByRole("searchbox");
    await query.fill("headphones");
    await query.focus();
    const y = await page.evaluate(() => scrollY);
    await Promise.all([headphones(maya).click(), headphones(priya).click()]);
    await variant(priya).selectOption({ label: "Black" });
    const share = (shopper) => shopper.getByRole("button", { name: "Share find" }).click();
    await Promise.all([share(maya), share(priya)]);
    await expect(page.locator("#open-finds")).toHaveAccessibleName("Around the room, 2 unseen");
    await expect(query).toBeFocused();
    expect(await page.evaluate(() => scrollY)).toBe(y);
    await expect(page.locator("#open-bag")).toHaveAccessibleName("Shared bag, 0 items");
    await expect(page.locator(".find-live-notice span")).toBeHidden({ timeout: 4500 });
    await variant(priya).selectOption({ label: "Stone" });
    await share(priya);
    await expect(page.locator(".find-live-notice span")).toBeHidden();
    await expect(page.locator("#open-finds")).toHaveAccessibleName("Around the room, 2 unseen");
    for (const shopper of pages) await shopper.locator("#open-finds").click();
    const ids = (shopper) => cards(shopper).evaluateAll((nodes) =>
      nodes.map((node) => node.dataset.findVariant));
    for (const shopper of pages) await expect(cards(shopper)).toHaveCount(2);
    const order = await ids(page);
    expect(await ids(maya)).toEqual(order);
    expect(await ids(priya)).toEqual(order);
    for (const shopper of pages)
      await expect(shopper.locator("#open-bag")).toHaveAccessibleName("Shared bag, 0 items");
    const stone = (shopper) => cards(shopper).filter({ hasText: "Stone" });
    await expect(stone(page)).toContainText("Shared by Maya");
    await expect(stone(page)).toContainText("Priya shared this again");
    if (process.env.COSHOP_EVIDENCE) {
      await expect(panel(page)).toHaveCSS("opacity", "1");
      await page.screenshot({ path: process.env.COSHOP_EVIDENCE + "/finds-1440.png" });
      await page.setViewportSize({ width: 360, height: 900 });
      await expect.poll(() => panel(page).evaluate((node) => node.matches(":modal"))).toBe(true);
      await expect(panel(page)).toHaveCSS("opacity", "1");
      await page.screenshot({ path: process.env.COSHOP_EVIDENCE + "/finds-360.png" });
      await page.setViewportSize({ width: 1440, height: 900 });
    }
    await page.reload();
    await expect(page.getByText("Connected", { exact: true })).toBeVisible();
    await expect(page.locator(".find-live-notice span")).toBeHidden();
    await page.locator("#open-finds").click();
    await expect(cards(page)).toHaveCount(2);
    expect(await ids(page)).toEqual(order);
    await cards(page).filter({ hasText: "Black" }).getByRole("button", { name: "View product" }).click();
    await expect(variant(page).locator("option:checked")).toHaveText("Black");
    await expect(variant(maya).locator("option:checked")).toHaveText("Stone");
    await page.getByRole("button", { name: "Add to bag" }).click();
    for (const shopper of pages)
      await expect(shopper.locator("#open-bag")).toHaveAccessibleName("Shared bag, 1 item");
    await priya.reload();
    await expect(priya.getByText("Connected", { exact: true })).toBeVisible();
    await expect(priya.locator("#open-bag")).toHaveAccessibleName("Shared bag, 1 item");
    await priya.locator("#open-finds").click();
    await expect(cards(priya)).toHaveCount(2);
    expect(await ids(priya)).toEqual(order);
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
  }
});

test("short drawer keeps chat composer docked and product controls below presence", async ({ page }) => {
  for (const width of [1440, 360]) {
    await page.setViewportSize({ width, height: 500 });
    await room(page);
    await page.locator("#open-finds").click();
    const drawer = page.locator("#finds-drawer");
    await drawer.getByRole("tab", { name: "Chat" }).click();
    await expect(drawer.getByText("Say hi or ask what everyone’s looking for.")).toBeVisible();
    const draft = drawer.getByRole("textbox", { name: "Message the room" });
    const send = drawer.getByRole("button", { name: "Send" });
    await expect(send).toBeDisabled();
    const first = await draft.boundingBox();
    await draft.fill("   ");
    await expect(send).toBeDisabled();
    await draft.fill("First line\nSecond line\nThird line\nFourth line");
    await expect(send).toBeEnabled();
    expect((await draft.boundingBox()).height).toBeGreaterThan(first.height);
    const distance = await drawer.evaluate((node) =>
      node.getBoundingClientRect().bottom -
      node.querySelector(".room-composer").getBoundingClientRect().bottom);
    expect(distance).toBeGreaterThan(0);
    expect(distance).toBeLessThanOrEqual(22);
    await page.keyboard.press("Escape");
    await expect(drawer).toBeHidden();
    await page.locator("#open-finds").click();
    await expect(draft).toHaveValue(/Fourth line/);
    await page.keyboard.press("Escape");
    await expect(drawer).toBeHidden();
    await page.getByRole("button", { name: "View Table Lamp" }).click();
    const layout = () => page.evaluate(() => {
      const bar = document.querySelector(".react-presence").getBoundingClientRect();
      const detail = document.querySelector("#product-dialog");
      return {
        back: detail.querySelector("button").getBoundingClientRect().top - bar.bottom,
        title: detail.querySelector("h2").getBoundingClientRect().top - bar.bottom,
        overflow: document.documentElement.scrollWidth > innerWidth,
      };
    });
    await expect.poll(async () => (await layout()).back).toBeGreaterThanOrEqual(0);
    expect(await layout()).toMatchObject({ overflow: false });
    expect((await layout()).title).toBeGreaterThan(0);
    if (process.env.COSHOP_EVIDENCE && width === 1440)
      await page.screenshot({ path: process.env.COSHOP_EVIDENCE + "/detail-1440.png" });
    await page.getByRole("button", { name: /Back to the collection/ }).click();
    await expect(page.getByRole("button", { name: "View Table Lamp" })).toBeFocused();
    if (process.env.COSHOP_EVIDENCE) {
      await page.locator("#open-finds").click();
      await expect(drawer).toHaveCSS("opacity", "1");
      await page.screenshot({ path: process.env.COSHOP_EVIDENCE + `/chat-${width}.png` });
    }
  }
});

test("quick add shares and adds the exact headphone variant with its photo", async ({ page, browser }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await room(page);
  const guest = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  try {
    const peer = await guest.newPage();
    await page.getByRole("button", { name: "Invite", exact: true }).click();
    const link = await page.getByRole("textbox", { name: "Invitation link" }).inputValue();
    await page.keyboard.press("Escape");
    await peer.goto(link);
    await peer.getByRole("textbox", { name: "Name (required)" }).fill("Maya");
    await peer.getByRole("button", { name: /Join your people/ }).click();
    await expect(peer.getByText("Connected", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Audio", exact: true }).click();
    const search = page.getByRole("searchbox");
    await search.fill("headphones");
    const tile = page.getByRole("button", { name: "View Over-Ear Headphones" });
    const quick = page.getByRole("button", { name: "Quick add Over-Ear Headphones" });
    const baselineWidth = (await tile.boundingBox()).width;
    expect((await quick.boundingBox()).width).toBe(44);
    const before = await page.evaluate(() => scrollY);
    await quick.press("Enter");
    const dialog = page.getByRole("dialog", { name: "Over-Ear Headphones" });
    await expect(page.locator("#product-dialog")).toHaveCount(0);
    const select = dialog.getByRole("combobox");
    await select.selectOption("audio-1");
    await expect(select.locator("option:checked")).toHaveText("Black · CAD 149.00");
    if (process.env.COSHOP_EVIDENCE) {
      await expect(dialog).toHaveCSS("opacity", "1");
      await page.screenshot({ path: process.env.COSHOP_EVIDENCE + "/quick-add.png" });
    }
    await dialog.getByRole("button", { name: "Share find" }).click();
    await expect(dialog.getByText("Shared in Our finds.")).toBeVisible();
    await peer.locator("#open-finds").click();
    const black = peer.locator('[data-find-variant="audio-1"]');
    await expect(black).toContainText("Black · CAD 149.00");
    await expect(black.locator("img")).toHaveAttribute("src", "/assets/catalog-audio-1.webp");
    await expect.poll(() => black.locator("img").evaluate(img => img.naturalWidth)).toBeGreaterThan(0);
    for (const shopper of [page, peer])
      await expect(shopper.locator("#open-bag")).toHaveAccessibleName("Shared bag, 0 items");

    await dialog.getByRole("button", { name: "Add to bag" }).click();
    for (const shopper of [page, peer])
      await expect(shopper.locator("#open-bag")).toHaveAccessibleName("Shared bag, 1 item");
    await select.selectOption("audio-0");
    await dialog.getByRole("button", { name: "Share find" }).click({ timeout: 7000 });
    const stone = peer.locator('[data-find-variant="audio-0"]');
    await expect(stone).toContainText("Stone · CAD 149.00");
    await expect(stone.locator("img")).toHaveAttribute("src", "/assets/catalog-audio.webp");
    await page.keyboard.press("Escape");
    await expect(quick).toBeFocused();
    await expect(search).toHaveValue("headphones");
    await expect(page.getByRole("button", { name: "Audio", exact: true })).toHaveAttribute("aria-pressed", "true");
    expect(await page.evaluate(() => scrollY)).toBe(before);
    expect((await tile.boundingBox()).width).toBe(baselineWidth);
    await peer.locator("#open-finds").click();
    await peer.locator("#open-bag").click();
    const line = peer.locator(".react-bag-line");
    await expect(line).toContainText("Black");
    await expect(line.locator("img")).toHaveAttribute("src", "/assets/catalog-audio-1.webp");
    if (process.env.COSHOP_EVIDENCE) {
      await expect(peer.locator("#bag-drawer")).toHaveCSS("opacity", "1");
      await peer.screenshot({ path: process.env.COSHOP_EVIDENCE + "/black-headphones-bag.png" });
    }
    await tile.click();
    const photo = page.locator(".detail-media img");
    await page.locator("#product-variant").selectOption("audio-1");
    await expect(photo).toHaveAttribute("src", "/assets/catalog-audio-1.webp");
    await page.locator("#product-variant").selectOption("audio-0");
    await expect(photo).toHaveAttribute("src", "/assets/catalog-audio.webp");
    await page.getByRole("button", { name: /Back to the collection/ }).click();
    await page.getByRole("button", { name: "Everything" }).click();
    await search.fill("sneakers");
    await page.getByRole("button", { name: "Quick add Sneakers" }).click();
    const sneakers = page.getByRole("dialog", { name: "Sneakers" });
    await sneakers.getByRole("combobox").selectOption("shoe-2");
    await expect(sneakers.getByRole("button", { name: "Unavailable" })).toBeDisabled();
  } finally {
    await guest.close();
  }
});

test("product gallery stays fitted and sharing uses the canonical variant photo", async ({ page, browser }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await room(page);
  const guest = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  try {
    const peer = await guest.newPage();
    await page.getByRole("button", { name: "Invite", exact: true }).click();
    const link = await page.getByRole("textbox", { name: "Invitation link" }).inputValue();
    await page.keyboard.press("Escape");
    await peer.goto(link);
    await peer.getByRole("textbox", { name: "Name (required)" }).fill("Maya");
    await peer.getByRole("button", { name: /Join your people/ }).click();
    await expect(peer.getByText("Connected", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "View Over-Ear Headphones" }).click();
    const rail = page.getByRole("group", { name: "Product photos" });
    const buttons = rail.getByRole("button");
    const photo = page.locator(".detail-media img");
    const variant = page.locator("#product-variant");
    await expect(buttons).toHaveCount(3);
    await expect(rail).toHaveCSS("flex-direction", "column");
    const frame = await page.locator(".detail-media").boundingBox();
    const scroll = await page.evaluate(() => scrollY);
    await buttons.nth(1).click();
    await expect(buttons.nth(1)).toHaveAttribute("aria-pressed", "true");
    await expect(photo).toHaveAttribute("src", "/assets/catalog-audio-side.webp");
    await buttons.nth(2).press("Space");
    await expect(buttons.nth(2)).toBeFocused();
    await expect(photo).toHaveAttribute("src", "/assets/catalog-audio-detail.webp");
    await expect(variant).toHaveValue("audio-0");
    expect(await page.locator(".detail-media").boundingBox()).toEqual(frame);
    expect(await page.evaluate(() => scrollY)).toBe(scroll);
    await variant.selectOption("audio-1");
    await expect(buttons.first()).toHaveAttribute("aria-pressed", "true");
    await expect(photo).toHaveAttribute("src", "/assets/catalog-audio-1.webp");
    await expect(buttons.nth(2).locator("img")).toHaveAttribute("src", "/assets/catalog-audio-1-detail.webp");
    await buttons.nth(2).click();
    await page.getByRole("button", { name: "Share find" }).click();
    await peer.locator("#open-finds").click();
    const find = peer.locator('[data-find-variant="audio-1"]');
    await expect(find.locator("img")).toHaveAttribute("src", "/assets/catalog-audio-1.webp");
    await expect(peer.locator("#open-bag")).toHaveAccessibleName("Shared bag, 0 items");
    await page.getByRole("button", { name: "Add to bag" }).click();
    await expect(peer.locator("#open-bag")).toHaveAccessibleName("Shared bag, 1 item");
    await peer.locator("#open-finds").click();
    await peer.locator("#open-bag").click();
    await expect(peer.locator(".react-bag-line img")).toHaveAttribute("src", "/assets/catalog-audio-1.webp");

    await page.locator("#open-finds").click();
    await expect(rail).toHaveCSS("flex-direction", "row");
    await page.keyboard.press("Escape");
    await page.setViewportSize({ width: 360, height: 900 });
    await expect(rail).toHaveCSS("flex-direction", "row");
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(360);
    await page.route(/catalog-audio(?:-1)?-(?:side|detail)\.webp$/, (route) => route.abort());
    await page.getByRole("button", { name: /Back to the collection/ }).click();
    await page.getByRole("button", { name: "View Over-Ear Headphones" }).click();
    await expect(rail).toHaveCount(0);
    await expect(photo).toHaveAttribute("src", "/assets/catalog-audio.webp");
  } finally {
    await guest.close();
  }
});

test("desktop Back label aligns with the gallery and single-photo fallback", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await room(page);
  await page.getByRole("button", { name: "Audio", exact: true }).click();
  const search = page.getByRole("searchbox");
  await search.fill("headphones");
  const card = page.getByRole("button", { name: "View Over-Ear Headphones" });
  const catalogScroll = await page.evaluate(() => scrollY);
  await card.click();
  const back = page.getByRole("button", { name: /Back to the collection/ });
  const offsets = () => back.evaluate((node) => {
    const label = document.createRange();
    label.selectNodeContents(node);
    const rect = label.getBoundingClientRect();
    const media = document.querySelector(".thumbnail-rail") ||
      document.querySelector(".detail-media");
    return {
      gap: Math.abs(rect.left - media.getBoundingClientRect().left),
      backClearance: rect.top - document.querySelector(".react-presence").getBoundingClientRect().bottom,
      titleClearance: document.querySelector("#product-heading").getBoundingClientRect().top -
        document.querySelector(".react-presence").getBoundingClientRect().bottom,
    };
  });
  for (const width of [1440, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await expect.poll(async () => (await offsets()).gap).toBeLessThanOrEqual(8);
    expect((await offsets()).backClearance).toBeGreaterThan(0);
    expect((await offsets()).titleClearance).toBeGreaterThan(0);
    await page.locator("#open-finds").click();
    await expect(page.locator(".thumbnail-rail")).toHaveCSS("flex-direction", "row");
    await expect(back).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    await page.keyboard.press("Escape");
    await expect(page.locator(".thumbnail-rail")).toHaveCSS("flex-direction", "column");
  }
  await back.click();
  await expect(card).toBeFocused();
  await expect(search).toHaveValue("headphones");
  await expect(page.getByRole("button", { name: "Audio", exact: true })).toHaveAttribute("aria-pressed", "true");
  expect(await page.evaluate(() => scrollY)).toBe(catalogScroll);
  await page.route(/catalog-audio-(?:side|detail)\.webp$/, (route) => route.abort());
  await card.click();
  await expect(page.locator(".thumbnail-rail")).toHaveCount(0);
  await expect.poll(async () => (await offsets()).gap).toBeLessThanOrEqual(8);
  await page.setViewportSize({ width: 360, height: 900 });
  await expect(back).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(360);
});

const uxShots = process.env.COSHOP_UX_SHOTS;
const shot = (page, name) =>
  uxShots ? page.screenshot({ path: join(uxShots, name + ".png") }) : null;

async function joinRoom(page, shopper, name) {
  await page.getByRole("button", { name: "Invite", exact: true }).click();
  const link = await page.getByRole("textbox", { name: "Invitation link" }).inputValue();
  await page.keyboard.press("Escape");
  await shopper.goto(link);
  await shopper.getByRole("textbox", { name: "Name (required)" }).fill(name);
  await shopper.getByRole("button", { name: /Join your people/ }).click();
  await expect(shopper.getByText("Connected", { exact: true })).toBeVisible();
}

const openHeadphones = (shopper) =>
  shopper.getByRole("button", { name: "View Over-Ear Headphones" }).click();
async function reloadToHeadphones(shopper) {
  await shopper.reload();
  await expect(shopper.getByText("Connected", { exact: true })).toBeVisible();
  if (!(await shopper.locator("#product-heading").isVisible())) await openHeadphones(shopper);
  await expect(shopper.locator("#product-heading")).toHaveText("Over-Ear Headphones");
}
const bagCount = (shopper, count) =>
  expect(shopper.locator("#open-bag")).toHaveAccessibleName(
    "Shared bag, " + count + (count === 1 ? " item" : " items"),
  );
const noOverflow = (shopper) =>
  expect
    .poll(() => shopper.evaluate(() => document.documentElement.scrollWidth - innerWidth))
    .toBeLessThanOrEqual(0);

for (const width of [360, 390, 1280, 1440]) {
  test(`finds shortcut, in-bag status and picker note for two shoppers at ${width}px`, async ({ page, browser }) => {
    const context = await browser.newContext();
    const maya = await context.newPage();
    try {
      for (const shopper of [page, maya]) await shopper.setViewportSize({ width, height: 800 });
      await room(page);
      await joinRoom(page, maya, "Maya");
      await page.evaluate(() => scrollTo(0, 700));
      const presence = page.locator(".react-presence");
      const height = (await presence.boundingBox()).height;
      await openHeadphones(maya);
      await maya.getByRole("combobox", { name: "Choose a variant" }).selectOption({ label: "Black" });
      await maya.getByRole("button", { name: "Share find" }).click();
      const narrow = width < 1180;
      const trigger = narrow ? page.locator(".finds-shortcut") : page.locator("#open-finds");
      await expect(trigger).toHaveAccessibleName(narrow ? "Our finds, 1 unseen" : "Around the room, 1 unseen");
      await expect(trigger).toBeInViewport();
      if (narrow) {
        expect((await presence.boundingBox()).height).toBe(height);
        await expect(page.locator("#open-finds")).not.toBeInViewport();
        await shot(page, `shortcut-${width}`);
      } else await expect(page.locator(".finds-shortcut")).toBeHidden();
      const y = await page.evaluate(() => scrollY);
      await trigger.focus();
      await page.keyboard.press("Enter");
      const panel = page.getByRole("dialog", { name: "Around the room" });
      const card = panel.locator("[data-find]").filter({ hasText: "Black" });
      await expect(card).toContainText("Not in bag yet");
      await expect(trigger).toHaveAccessibleName(narrow ? "Our finds" : "Around the room");
      await page.keyboard.press("Escape");
      await expect(panel).toBeHidden();
      await expect(trigger).toBeFocused();
      await expect(trigger).toBeInViewport();
      expect(await page.evaluate(() => scrollY)).toBe(y);
      await maya.getByRole("button", { name: "Add to bag" }).click();
      await bagCount(page, 1);
      await trigger.click();
      await expect(card).toContainText("In bag · 1");
      await page.keyboard.press("Escape");
      await expect(panel).toBeHidden();
      await page.locator("#open-bag").click();
      const line = page.locator("#bag-items .react-bag-line");
      await expect(line).toContainText("Only Maya can lower or remove this.");
      await expect(line.getByRole("button", { name: /^Remove/ })).toHaveCount(0);
      await noOverflow(page);
      await shot(page, `picker-note-${width}`);
      await page.keyboard.press("Escape");
    } finally {
      await context.close();
    }
  });
}

async function routeRoomSocket(page) {
  const route = { send: (m) => m, receive: (m) => m };
  await page.routeWebSocket(/.*/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((message) => {
      const next = route.send(String(message));
      if (next != null) server.send(next);
    });
    server.onMessage((message) => {
      const next = route.receive(String(message));
      if (next != null) ws.send(next);
    });
  });
  return route;
}
const pass = (m) => m;
const interrupted = "Review your bag; an update was interrupted.";

test("reload after an unsent or unacknowledged add shows a cautious review notice once", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  const route = await routeRoomSocket(page);
  await room(page);
  await openHeadphones(page);
  const add = page.getByRole("button", { name: "Add to bag" });
  const toast = page.locator(".react-toast");

  route.send = (m) => (m.includes('"bag_change"') ? null : m);
  await add.click();
  await expect(page.getByRole("button", { name: "Saving…" })).toBeVisible();
  route.send = pass;
  await reloadToHeadphones(page);
  await expect(toast).toHaveText(interrupted);
  await bagCount(page, 0);
  await shot(page, "interrupted-unsent-390");
  await reloadToHeadphones(page);
  await expect(toast).not.toHaveText(interrupted);

  route.receive = (m) => (m.includes('"command_ack"') && m.includes('"bag"') ? null : m);
  await page.getByRole("button", { name: "Add to bag" }).click();
  await bagCount(page, 1);
  route.receive = pass;
  await reloadToHeadphones(page);
  await expect(toast).toHaveText(interrupted);
  await page.waitForTimeout(3000);
  await bagCount(page, 1);
  await page.locator("#open-bag").click();
  await expect(page.locator("#bag-status")).toHaveText(interrupted);
});

test("rejected changes and the 99 cap explain themselves; a later success clears stale errors", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  const route = await routeRoomSocket(page);
  await page.route(/\/haul-demo$/, (request) =>
    request.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ code: "TEST_DEMO", message: "Demo recap failed in test." }),
    }),
  );
  await room(page);
  await openHeadphones(page);
  route.send = (m) =>
    m.includes('"bag_change"') ? m.replace(/"variantId":"[^"]+"/, '"variantId":"tampered"') : m;
  await page.getByRole("button", { name: "Add to bag" }).click();
  await expect(page.locator(".react-toast")).not.toHaveText("");
  const rejection = await page.locator(".react-toast").textContent();
  await bagCount(page, 0);
  route.send = pass;
  await page.getByRole("button", { name: "Add to bag" }).click();
  await bagCount(page, 1);
  await page.locator("#open-bag").click();
  const status = page.locator("#bag-status");
  await expect(status).not.toHaveText(rejection);
  await page.getByRole("button", { name: "Demo completion · simulated" }).click();
  await expect(status).toHaveText("Demo recap failed in test.");
  await page.getByRole("button", { name: /^Increase quantity/ }).click();
  await expect(status).toHaveText(/^Added Over-Ear Headphones/);
  await page.keyboard.press("Escape");

  const capped = (m) =>
    m.replace(/"quantity":\d+/g, '"quantity":99').replace(/"totalQuantity":\d+/g, '"totalQuantity":99');
  route.receive = (m) => (m.includes('"bag"') ? capped(m) : m);
  await page.route(/\/session$/, async (request) => {
    const response = await request.fetch();
    await request.fulfill({ response, body: capped(await response.text()) });
  });
  await page.reload();
  await expect(page.getByText("Connected", { exact: true })).toBeVisible();
  await page.locator("#open-bag").click();
  const increase = page.getByRole("button", { name: /^Increase quantity/ });
  await expect(increase).toHaveAttribute("aria-disabled", "true");
  await expect(increase).toHaveAccessibleDescription("Limit 99 per item.");
  await noOverflow(page);
  await shot(page, "cap-note-360");
});

test("reconnect highlights changed bag lines once and reduced motion keeps a static outline", async ({ page, browser }) => {
  const context = await browser.newContext(
    process.env.COSHOP_UX_VIDEO ? { recordVideo: { dir: process.env.COSHOP_UX_VIDEO } } : {},
  );
  const maya = await context.newPage();
  try {
    for (const shopper of [page, maya]) await shopper.setViewportSize({ width: 1440, height: 900 });
    await room(page);
    await joinRoom(page, maya, "Maya");
    await openHeadphones(page);
    await openHeadphones(maya);
    await page.getByRole("button", { name: "Add to bag" }).click();
    await bagCount(maya, 1);
    await expect(page.getByRole("button", { name: "Add to bag" })).toBeVisible();
    const status = page.locator("#bag-status");
    const changed = page.locator("#bag-items .react-bag-line.line-changed");
    const reconnectWhile = async (action) => {
      await page.context().setOffline(true);
      await expect(page.getByText("Reconnecting…", { exact: true }).first()).toBeVisible();
      await action();
      await page.context().setOffline(false);
      await expect(page.getByText("Connected", { exact: true })).toBeVisible();
    };
    await reconnectWhile(async () => {
      await maya.getByRole("button", { name: "Add to bag" }).click();
      await bagCount(maya, 2);
    });
    await bagCount(page, 2);
    await page.locator("#open-bag").click();
    await expect(changed).toHaveCount(1);
    await expect(changed).toContainText("Updated");
    await expect(status).toHaveText("Bag refreshed · 1 line changed.");
    await shot(page, "line-changed-1440");
    await expect(changed).toHaveCount(0, { timeout: 6000 });
    await expect(status).toHaveText("");
    await page.keyboard.press("Escape");

    await reconnectWhile(async () => {});
    await page.locator("#open-bag").click();
    await expect(page.locator("#bag-items .react-bag-line")).toHaveCount(1);
    await page.waitForTimeout(500);
    await expect(changed).toHaveCount(0);
    await expect(status).toHaveText("");
    await page.keyboard.press("Escape");

    await page.emulateMedia({ reducedMotion: "reduce" });
    await reconnectWhile(async () => {
      await maya.getByRole("button", { name: "Add to bag" }).click();
      await bagCount(maya, 3);
    });
    await page.locator("#open-bag").click();
    await expect(changed).toHaveCount(1);
    await expect(changed).toHaveCSS("animation-name", "none");
    await expect(changed).toHaveCSS("outline-style", "solid");
    await expect(changed).toContainText("Updated");
  } finally {
    await context.close();
  }
});

test("selected gallery photo survives refresh per variant and ignores invalid saved photos", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await room(page);
  await openHeadphones(page);
  const rail = page.getByRole("group", { name: "Product photos" });
  const thumbs = rail.getByRole("button");
  await thumbs.nth(1).click();
  await expect(thumbs.nth(1)).toHaveAttribute("aria-pressed", "true");
  await reloadToHeadphones(page);
  await expect(thumbs.nth(1)).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("combobox", { name: "Choose a variant" }).selectOption({ label: "Black" });
  await expect(thumbs.nth(0)).toHaveAttribute("aria-pressed", "true");
  await page.evaluate(() => {
    for (const key of Object.keys(sessionStorage))
      if (key.startsWith("coshop:photo:")) sessionStorage.setItem(key, "/assets/missing.webp");
  });
  await reloadToHeadphones(page);
  await page.getByRole("combobox", { name: "Choose a variant" }).selectOption({ label: "Stone" });
  await expect(thumbs.nth(0)).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".detail-media")).not.toContainText("Image unavailable");
});
