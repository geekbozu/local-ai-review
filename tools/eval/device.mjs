// Making a model available, where that is a thing.
//
// A normal OpenAI-compatible endpoint serves every model it has, so the runner needs to do nothing: the model id in the
// config is enough. The device this was built against keeps **one** model resident and answers 404 for any other, so it
// needs to be told to load one and then waited for.
//
// That is a property of one device, not of the review, so it is an adapter selected by `--device`, and the default
// (`none`) does nothing at all. Anything added here must be justifiable as "this endpoint cannot serve the model", never
// as convenience.

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Tiiny Pocket: `POST /api/v1/models/{id}/launch`, then poll `/api/v1/models/running`.
const tiiny = (baseUrl, key) => {
  const base = baseUrl.replace(/\/v1\/?$/, "");
  const headers = { authorization: `Bearer ${key}` };
  const running = async () => {
    const res = await fetch(`${base}/api/v1/models/running`, { headers });
    if (!res.ok) throw new Error(`device said ${res.status} listing running models`);
    return (await res.json()).running || [];
  };

  return {
    name: "tiiny",
    async ensure(model) {
      if ((await running()).includes(model)) return;
      console.log(`  loading ${model} …`);
      const res = await fetch(`${base}/api/v1/models/${encodeURIComponent(model)}/launch`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ model_id: model }),
      });
      if (!res.ok) throw new Error(`device said ${res.status} launching ${model}`);
      for (let i = 0; i < 48; i += 1) {
        if ((await running()).includes(model)) return;
        await sleep(5000);
      }
      throw new Error(`${model} did not come up within four minutes`);
    },
  };
};

const none = { name: "none", async ensure() {} };

export const devices = { none, tiiny };

export const device = ({ kind, baseUrl, key }) => {
  const factory = devices[kind];
  if (!factory) throw new Error(`unknown --device "${kind}": expected one of ${Object.keys(devices).join(", ")}`);
  return factory(baseUrl, key);
};
