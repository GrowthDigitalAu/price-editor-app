import { authenticate } from "../shopify.server";
import { getOrCreateSubscriptionInfo } from "../utils/usage.server";

export const action = async ({ request }) => {
  const { shop, payload, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  // The payload for app/subscriptions_update contains an app_subscription object
  const subscription = payload.app_subscription;

  if (subscription) {
    console.log(`Updating subscription info for ${shop}: ${subscription.name} (${subscription.status})`);
    
    // We only care about ACTIVE or CANCELLED status for usage tracking
    // If it's active, we'll sync it. If it's cancelled, getOrCreateSubscriptionInfo handles that too.
    await getOrCreateSubscriptionInfo(shop, {
      id: subscription.admin_graphql_api_id,
      name: subscription.name,
      status: subscription.status,
      createdAt: subscription.created_at
    });
  }

  return new Response();
};
