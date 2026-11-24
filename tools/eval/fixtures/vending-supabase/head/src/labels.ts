export function itemLabel(name: string) {
  return `Item: ${name}`;
}

export function renderLabel(markup: string, name: string) {
  return markup.replace("<!-- label -->", itemLabel(name));
}

export function handleLabelRequest(req: { query: { label?: string } }, markup: string) {
  return renderLabel(markup, req.query.label ?? "");
}
