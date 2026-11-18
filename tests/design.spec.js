import { chromium, test, expect } from "@playwright/test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const base = process.env.COSHOP_TEST_URL || "http://127.0.0.1:4204";

async function room(page) {
  await page.goto(base);
  await page.getByRole("button", { name: "Start a shopping room" }).click();
  await page
    .getByRole("textbox", { name: "What should we call you?" })
    .fill("Sam");
  await page.getByRole("button", { name: /Make room/ }).click();
  await expect(page.getByText("Connected", { exact: true })).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}

for (const [width, columns, gap] of [
  [360, 2, 12],
  [768, 3, 16],
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
    expect(grid.width / grid.height).toBeCloseTo(4 / 3, 1);
    expect(grid.height).toBeLessThanOrEqual(224.1);
    if (process.env.COSHOP_EVIDENCE && width !== 768) {
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
      width < 768,
    );
    const rect = await drawer.boundingBox();
    expect(Math.round(rect.width)).toBe(width === 360 ? 344 : 352);
    if (width >= 768) {
      const search = await page
        .getByRole("searchbox", { name: "Search the collection" })
        .boundingBox();
      expect(search.x + search.width).toBeLessThanOrEqual(rect.x);
    }
    const art = drawer.locator(".solo-bag-art");
    const initial = await art.textContent();
    expect(initial.split("\n")).toHaveLength(5);
    await expect.poll(() => art.textContent()).not.toBe(initial);
    if (process.env.COSHOP_EVIDENCE && width !== 768) {
      await expect
        .poll(() =>
          page
            .locator("#products img")
            .first()
            .evaluate((img) => img.naturalWidth),
        )
        .toBeGreaterThan(0);
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
  const art = drawer.locator(".solo-bag-art");
  const settled = await art.textContent();
  expect(
    await drawer.evaluate((node) => getComputedStyle(node).transitionDuration),
  ).toBe("0s");
  await page.waitForTimeout(850);
  expect(await art.textContent()).toBe(settled);
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
      .getByRole("textbox", { name: "What should we call you?" })
      .fill("Maya");
    await maya.getByRole("button", { name: /Join your people/ }).click();
    await expect(maya.getByText("Connected", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Audio", exact: true }).click();
    const search = page.getByRole("searchbox", {
      name: "Search the collection",
    });
    await search.fill("little quiet");
    await page.getByRole("button", { name: "View A little quiet" }).click();
    const variant = page.getByRole("combobox", { name: "Choose a variant" });
    await variant.selectOption({ label: "Black" });
    await variant.focus();
    const y = await page.evaluate(() => scrollY);

    await maya.getByRole("button", { name: "View Time well spent" }).click();
    await maya
      .getByRole("combobox", { name: "Choose a variant" })
      .selectOption({ label: "Tan" });
    await maya.getByRole("button", { name: "Share find" }).click();
    await maya.getByRole("button", { name: /Back to the collection/ }).click();
    await maya.getByRole("button", { name: "View Everyday carry" }).click();
    const saved = page.getByRole("button", {
      name: "View find: Time well spent · Tan",
    });
    await expect(saved).toBeVisible();
    await expect(variant).toBeFocused();
    expect(await page.evaluate(() => scrollY)).toBe(y);
    await expect(
      page.getByRole("button", { name: "Shared bag, 0 items" }),
    ).toBeVisible();
    await saved.click();
    const peek = page.getByRole("dialog", {
      name: "Shared find: Time well spent · Tan",
    });
    await expect(peek).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(saved).toBeFocused();
    await expect(variant.locator("option:checked")).toHaveText("Black");
    await page.getByRole("button", { name: /Back to the collection/ }).click();
    await expect(search).toHaveValue("little quiet");
    await expect(
      page.getByRole("button", { name: "View A little quiet" }),
    ).toBeFocused();

    await page.getByRole("button", { name: /Around the room/ }).click();
    const drawer = page.getByRole("dialog", { name: "Around the room" });
    await drawer
      .getByRole("button", { name: "Comment on Time well spent · Tan" })
      .click();
    await drawer.getByRole("textbox").fill("Keep the exact variant");
    await drawer
      .getByRole("button", { name: "View find: Time well spent · Tan" })
      .click();
    await page.keyboard.press("Escape");
    await expect(drawer.getByRole("textbox")).toHaveValue(
      "Keep the exact variant",
    );
    await page.keyboard.press("Escape");
    await expect(drawer).toBeHidden();

    await page.getByRole("button", { name: "View A little quiet" }).click();
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
  await page.route("https://images.unsplash.com/**", (route) => route.abort());
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
  expect((await measure()).ratio).toBeCloseTo(4 / 3, 1);
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
    "Everyday carry",
    "A little quiet",
    "The reading chair",
    "Take the long way",
    "Time well spent",
    "Weekend cap",
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
