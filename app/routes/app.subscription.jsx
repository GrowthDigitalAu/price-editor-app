import { useState } from "react";
import { useLoaderData, useSubmit, useNavigation } from "react-router";
import {
  Text,
  Button,
  BlockStack,
  Box,
  Divider,
  Modal,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);

  const billingCheck = await admin.graphql(
    `#graphql
      query {
        currentAppInstallation {
          activeSubscriptions {
            id
            name
            status
            test
            createdAt
          }
        }
      }
    `
  );

  const billingJson = await billingCheck.json();
  const activeSubscriptions =
    billingJson.data?.currentAppInstallation?.activeSubscriptions || [];
  
  const shopName = session.shop.replace(".myshopify.com", "");

  return {
    subscription: activeSubscriptions[0] || null,
    manageUrl: `https://admin.shopify.com/store/${shopName}/charges/gd-price-updator-app/pricing_plans`,
  };
};

export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const subscriptionId = formData.get("subscriptionId");

  if (!subscriptionId) {
    return { error: "Subscription ID is required" };
  }

  const response = await admin.graphql(
    `#graphql
      mutation AppSubscriptionCancel($id: ID!) {
        appSubscriptionCancel(id: $id) {
          appSubscription {
            id
            status
            test
          }
          userErrors {
            field
            message
          }
        }
      }
    `,
    {
      variables: {
        id: subscriptionId,
      },
    }
  );

  const responseJson = await response.json();
  const errors = responseJson.data?.appSubscriptionCancel?.userErrors;

  if (errors && errors.length > 0) {
    return { error: errors[0].message };
  }

  return { success: true };
};

export default function SubscriptionPage() {
  const { subscription, manageUrl } = useLoaderData();
  const submit = useSubmit();
  const navigation = useNavigation();
  const [modalOpen, setModalOpen] = useState(false);

  const isSubmitting = navigation.state === "submitting";

  const handleCancel = () => {
    setModalOpen(true);
  };

  const confirmCancel = () => {
    setModalOpen(false);
    submit(
      { subscriptionId: subscription.id },
      { method: "POST" }
    );
  };

  return (
    <s-page heading="Subscription">
      <s-box paddingBlockStart="large">
        <s-section>
          <BlockStack gap="400">
            <Text as="h2" variant="headingMd">
              Current Plan
            </Text>
            
            {subscription ? (
              <Box>
                <Text as="p" variant="bodyMd" fontWeight="bold">
                  {subscription.name}
                </Text>
                <Text as="p" variant="bodySm" tone={subscription.status === 'ACTIVE' ? 'success' : 'critical'}>
                  Status: {subscription.status}
                </Text>
                {subscription.test && (
                  <Text as="p" variant="bodySm" tone="subdued">
                    (Test Charge)
                  </Text>
                )}
              </Box>
            ) : (
              <Text as="p" tone="critical">
                No active subscription found.
              </Text>
            )}

            <Divider />

            <BlockStack gap="200">
              <Text as="p" variant="bodyMd">
                {subscription 
                  ? "Change or cancel your plan below." 
                  : "You need a subscription to use this app."}
              </Text>
              
              <BlockStack gap="200" inlineAlign="start">
                <Button url={manageUrl} target="_top" variant="primary">
                  {subscription ? "Change Plan" : "Choose a Plan"}
                </Button>
                
                {subscription && (
                  <Button tone="critical" onClick={handleCancel} loading={isSubmitting}>
                    Cancel Subscription
                  </Button>
                )}
              </BlockStack>
            </BlockStack>
          </BlockStack>
        </s-section>
      </s-box>

      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title="Cancel Subscription"
        primaryAction={{
          content: 'Cancel Subscription',
          onAction: confirmCancel,
          destructive: true,
          loading: isSubmitting,
        }}
        secondaryActions={[
          {
            content: 'Keep Subscription',
            onAction: () => setModalOpen(false),
          },
        ]}
      >
        <Modal.Section>
          <BlockStack gap="400">
            <p>
              Are you sure you want to cancel your subscription? You will lose access to app features immediately.
            </p>
          </BlockStack>
        </Modal.Section>
      </Modal>
    </s-page>
  );
}
