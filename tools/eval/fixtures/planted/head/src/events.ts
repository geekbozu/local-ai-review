export function eventTitle(name: string) {
  return `Event: ${name}`;
}

export function renderTitle(html: string, name: string) {
  return html.replace("<!-- title -->", eventTitle(name));
}
