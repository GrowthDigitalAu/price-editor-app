import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { useNavigate } from "react-router";

export const loader = async ({ request }) => {
  await authenticate.admin(request);
  return null;
};

export default function Index() {

  return (
    <s-page heading="Welcome to Price Updator Pro">
      <s-box paddingBlockStart="large" paddingBlockEnd="large">
        <s-section heading="Use the sidebar to access Import and Export features.">
          <s-paragraph>
            This app allows you to bulk edit your product prices in your Shopify store.
          </s-paragraph>
        </s-section>
      </s-box>
    </s-page>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
