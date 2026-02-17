import { authenticate } from "../shopify.server";

export const action = async ({ request }) => {
  const { topic, shop, payload } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  switch (topic) {
    case "CUSTOMERS_DATA_REQUEST":
      console.log("Handling CUSTOMERS_DATA_REQUEST");
      // Process data request
      break;
    case "CUSTOMERS_REDACT":
      console.log("Handling CUSTOMERS_REDACT");
      // Process customer redaction
      break;
    case "SHOP_REDACT":
      console.log("Handling SHOP_REDACT");
      // Process shop redaction
      break;
    default:
      console.log(`Unhandled topic: ${topic}`);
      break;
  }

  return new Response("OK", { status: 200 });
};
