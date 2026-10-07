import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

/**
 * Browser tests (spec NFR-T4, section 10) for UC-1, UC-3, UC-6, UC-7, UC-9
 * and UC-10. The app runs locally with a scripted model: it picks a tool
 * from words in the question and then writes one fixed line, so what is
 * tested here is the app and its cards, not the model.
 */

const SPIKE = "Usage spike";
const REPLY = "The details are in the card above.";

const lastMonth = (): string => {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1))
    .toISOString()
    .slice(0, 7);
};

const SPIKE_ID = "usage-spike";
const dataSwitch = (page: Page) => page.getByRole("combobox");
// The banner, not the chat message that announces the switch.
const banner = (page: Page) =>
  page.locator("output", {
    hasText: `Test mode: ${SPIKE}. Figures are fixture data.`
  });

async function open(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.getByText("Connected")).toBeVisible();
  await expect(dataSwitch(page)).toBeVisible();
}

/** Opens the app with an empty conversation, in the mode asked for. */
async function start(page: Page, mode: "live" | "test"): Promise<void> {
  await open(page);
  await dataSwitch(page).selectOption(mode === "test" ? SPIKE_ID : "live");
  if (mode === "test") await expect(banner(page)).toBeVisible();
  else await expect(banner(page)).toBeHidden();
  await page.getByRole("button", { name: "Clear" }).click();
  await expect(page.getByText("Start a conversation")).toBeVisible();
}

async function ask(page: Page, question: string): Promise<void> {
  await page.getByPlaceholder("Send a message...").fill(question);
  await page.getByRole("button", { name: "Send message" }).click();
}

/** No accessibility violation that axe rates serious or critical. */
async function expectAccessible(page: Page): Promise<void> {
  const { violations } = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  const blocking = violations
    .filter((item) => item.impact === "serious" || item.impact === "critical")
    .map(
      (item) => `${item.id}: ${item.nodes.map((n) => n.target).join(" | ")}`
    );
  expect(blocking).toEqual([]);
}

test("UC-9: the usage summary is on screen before any message is sent", async ({
  page
}) => {
  await start(page, "live");
  const panel = page.getByRole("region", { name: "Usage this period" });
  await expect(panel).toBeVisible();
  await expect(panel.getByText(/^Period \d{4}-\d{2}-\d{2} to /)).toBeVisible();
  // Either the account's real rows, or a plain statement that there are none.
  await expect(
    panel
      .getByRole("table")
      .or(panel.getByText("No usage recorded this period."))
  ).toBeVisible();
  // The chat keeps its room: the panel never fills the window.
  const box = await panel.boundingBox();
  expect(box?.height ?? 0).toBeLessThan((page.viewportSize()?.height ?? 0) / 2);
  await expectAccessible(page);
});

test("UC-10: test mode is entered and left from the header, is labelled, and survives a reload", async ({
  page
}) => {
  await start(page, "live");
  await dataSwitch(page).selectOption(SPIKE_ID);
  await expect(banner(page)).toBeVisible();
  const panel = page.getByRole("region", { name: /Usage this period/ });
  await expect(panel.getByText("Test data")).toBeVisible();
  await expect(panel.getByRole("rowheader", { name: /R2/ })).toBeVisible();
  await expect(
    page.getByText(`Switched to test mode: ${SPIKE}. Figures are fixture data.`)
  ).toBeVisible();

  await page.reload();
  await expect(banner(page)).toBeVisible();
  await expectAccessible(page);

  await dataSwitch(page).selectOption("live");
  await expect(banner(page)).toBeHidden();
  await expect(page.getByText("Switched to live data.").last()).toBeVisible();
  await expect(panel.getByText("Test data")).toBeHidden();
});

test("UC-10: a switch asked for in chat needs the owner's confirmation", async ({
  page
}) => {
  await start(page, "live");
  await ask(page, "Switch to test mode");
  await expect(page.getByText("Approval needed: setDataMode")).toBeVisible();
  await expect(banner(page)).toBeHidden();
  await page.getByRole("button", { name: "Reject" }).click();
  await expect(page.getByText("Approval needed: setDataMode")).toBeHidden();
  await expect(banner(page)).toBeHidden();

  await ask(page, "Switch to test mode please");
  await page.getByRole("button", { name: "Approve" }).click();
  await expect(banner(page)).toBeVisible();
});

test("UC-1: a bill explanation is shown as a breakdown card, labelled as test data", async ({
  page
}) => {
  await start(page, "test");
  await ask(page, "Why is my bill higher than usual?");
  const card = page.getByRole("region", {
    name: /^Bill breakdown for \d{4}-\d{2}$/
  });
  await expect(card).toBeVisible();
  await expect(card.getByText("Test data")).toBeVisible();
  await expect(
    card.getByText("Workers", { exact: true }).first()
  ).toBeVisible();
  await expect(card.getByText(/above usual/).first()).toBeVisible();
  await expect(card.getByText(/\$\d/).first()).toBeVisible();
  await expect(page.getByText(REPLY)).toBeVisible();
  await expectAccessible(page);
});

test("UC-3: a credit request draft is shown with how to submit it, and is still there after a reload", async ({
  page
}) => {
  await start(page, "test");
  await ask(page, "I want a credit for the Workers spike: a Worker looped.");
  const card = page.getByRole("region", { name: "Credit request draft" });
  await expect(card).toBeVisible();
  await expect(
    card.getByText("Test data. Do not submit.").first()
  ).toBeVisible();
  await expect(card.getByText("Not submitted by this assistant")).toBeVisible();
  await expect(card.getByText(/Amount requested: \$\d/)).toBeVisible();
  await expect(
    card.getByText('"I want a credit for the Workers spike: a Worker looped."')
  ).toBeVisible();
  await expect(card.getByRole("button", { name: "Copy draft" })).toBeVisible();
  await expect(card.getByText("How to submit it yourself")).toBeVisible();
  await expect(
    card.getByRole("link", { name: "Cloudflare: contacting support" })
  ).toHaveAttribute(
    "href",
    "https://developers.cloudflare.com/support/contacting-cloudflare-support/"
  );
  await expect(page.getByText(REPLY)).toBeVisible();
  await expectAccessible(page);

  await page.reload();
  await expect(
    page.getByRole("region", { name: "Credit request draft" })
  ).toBeVisible();
});

test("UC-7: a plan comparison is shown as an estimate", async ({ page }) => {
  await start(page, "test");
  await ask(page, "Would another plan be cheaper?");
  const card = page.getByRole("region", {
    name: /^Plan comparison for \d{4}-\d{2}$/
  });
  await expect(card).toBeVisible();
  await expect(card.getByText("Estimate at list price")).toBeVisible();
  await expect(card.getByText("Test data")).toBeVisible();
  await expect(card.getByText(/Workers Paid: estimated \$\d/)).toBeVisible();
  await expect(card.getByText(/Workers Free: estimated \$0\.00/)).toBeVisible();
  await expect(
    card.getByText(/usage beyond a limit fails/i).first()
  ).toBeVisible();
  await expect(page.getByText(REPLY)).toBeVisible();
  await expectAccessible(page);
});

test("UC-6: an invoice close is approved from the approval card, and only there", async ({
  page
}) => {
  await start(page, "test");
  const month = lastMonth();
  await ask(page, "Please close last month.");
  const approval = page.getByRole("region", {
    name: `Approve the invoice close for ${month}`
  });
  await expect(approval).toBeVisible();
  await expect(
    approval.getByText("Test data. No real period is closed.")
  ).toBeVisible();
  await expect(approval.getByRole("cell", { name: "Total" })).toBeVisible();
  await expectAccessible(page);

  await approval
    .getByLabel("Reason (optional)")
    .fill("Checked against the invoice.");
  await approval
    .getByRole("button", { name: `Approve and close ${month}` })
    .click();
  await expect(approval).toBeHidden();

  // Asking again shows the close as final: a period closes once only.
  await ask(page, "Please close last month again.");
  await expect(
    page.getByText("Closed. The period's figures are final.")
  ).toBeVisible();
  await expect(
    page.getByText("Owner's reason: Checked against the invoice.", {
      exact: false
    })
  ).toBeVisible();
});
