// Test-only preload (`node --import`): answers Storefront API calls for
// *.myshopify.com so the Node server can run checkout without network access.
const real = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : input.url);
  if (!url.hostname.endsWith(".myshopify.com")) return real(input, init);
  const { query, variables } = JSON.parse(init.body);
  const variant = {
    id: "gid://shopify/ProductVariant/42",
    title: "Forest",
    availableForSale: true,
    image: null,
    price: { amount: "25.00", currencyCode: "CAD" },
  };
  if (query.includes("CoshopProducts"))
    return Response.json({
      data: {
        shop: { name: "Fake", primaryDomain: { host: url.hostname } },
        products: {
          nodes: [
            {
              id: "gid://shopify/Product/24",
              title: "Jacket",
              description: "A jacket.",
              productType: "Wear",
              variants: { nodes: [variant], pageInfo: { hasNextPage: false } },
            },
          ],
        },
      },
    });
  if (query.includes("CoshopVariants"))
    return Response.json({ data: { nodes: [variant] } });
  const { lines, attributes = [] } = variables.input;
  // Cart token is derivable by tests: "fake-" + attempt id.
  const attempt = attributes[0]?.value.split(".")[1] ?? "none";
  return Response.json({
    data: {
      cartCreate: {
        userErrors: [],
        warnings: [],
        cart: {
          id: `gid://shopify/Cart/fake-${attempt}?key=server-only`,
          checkoutUrl: `https://${url.hostname}/cart/c/${attributes[0]?.value ?? "none"}`,
          lines: {
            nodes: lines.map((line) => ({
              quantity: line.quantity,
              merchandise: { id: line.merchandiseId },
            })),
          },
          cost: {
            subtotalAmount: {
              amount: (lines[0].quantity * 25).toFixed(2),
              currencyCode: "CAD",
            },
          },
        },
      },
    },
  });
};
