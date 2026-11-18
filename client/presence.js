export function resolveLocation(view, products) {
  if (!view)
    return { title: "Looking around", kind: "category", category: "All" };
  if (view.kind === "category")
    return {
      ...view,
      title: view.category === "All" ? "The whole collection" : view.category,
    };
  const product = products.find((p) => p.id === view.productId);
  const variant = product?.variants.find((v) => v.id === view.variantId);
  if (!product || !variant)
    return { ...view, missing: true, title: "An item no longer here" };
  return { ...view, product, variant, title: product.name };
}
