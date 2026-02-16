import { useState, useEffect, useRef } from "react";
import { useFetcher, useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import ExcelJS from "exceljs";
import { useAppBridge } from "@shopify/app-bridge-react";
import { Pagination, ProgressBar, Card, Text, BlockStack, Badge, InlineStack, Banner } from "@shopify/polaris";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { getOrCreateSubscriptionInfo, getUsageStats, checkUsageLimit, incrementUsage } from "../utils/usage.server";

export const loader = async ({ request }) => {
    const { admin, session } = await authenticate.admin(request);
    const shop = session.shop;
    const url = new URL(request.url);
    const checkStatus = url.searchParams.get("checkStatus");
    const operationId = url.searchParams.get("operationId");

    // Fetch subscription info
    const billingCheck = await admin.graphql(
        `#graphql
          query {
            currentAppInstallation {
              activeSubscriptions {
                id
                name
                status
                createdAt
              }
            }
          }
        `
    );
    const billingJson = await billingCheck.json();
    const subscription = billingJson.data?.currentAppInstallation?.activeSubscriptions?.[0] || null;

    // Sync in DB
    const subInfo = await getOrCreateSubscriptionInfo(shop, subscription);
    const planName = subInfo.planName;

    // Get usage stats
    const usageStats = await getUsageStats(shop, planName);

    if (checkStatus === "true" && operationId) {
        const response = await admin.graphql(
            `#graphql
            query($id: ID!) {
                node(id: $id) {
                    ... on BulkOperation {
                        id
                        status
                        objectCount
                        url
                    }
                }
            }`,
            { variables: { id: operationId } }
        );

        const data = await response.json();
        const bulkOperation = data.data?.node;

        if (!bulkOperation) {
            return { success: false, status: "NONE", operationId, usageStats, planName };
        }

        if (bulkOperation.status === "COMPLETED") {
             let bulkErrors = [];
             
             if (bulkOperation.url) {
                try {
                    const fileResponse = await fetch(bulkOperation.url);
                    const text = await fileResponse.text();
                    const lines = text.split("\n").filter(line => line.trim() !== "");
                    lines.forEach(line => {
                        const result = JSON.parse(line);
                        const userErrors = result.productVariantsBulkUpdate?.userErrors || [];
                        if (userErrors.length > 0) {
                             bulkErrors.push(userErrors[0].message);
                        }
                    });
                } catch (e) {
                }
             }
             
             return { success: true, status: "COMPLETED", bulkResults: { errors: bulkErrors }, operationId, usageStats, planName };

        } else if (bulkOperation.status === "RUNNING" || bulkOperation.status === "CREATED") {
             return { success: true, status: "RUNNING", progress: bulkOperation.objectCount, operationId, usageStats, planName };
        } else {
             return { success: false, status: bulkOperation.status, operationId, usageStats, planName };
        }
    }

    return { success: true, usageStats, planName };
};

export const action = async ({ request }) => {
    const { admin, session } = await authenticate.admin(request);
    const shop = session.shop;
    const formData = await request.formData();
    const dataString = formData.get("data");
    const headersString = formData.get("headers");
    const rows = JSON.parse(dataString);
    const headersFromFrontend = headersString ? JSON.parse(headersString) : null;

    const results = {
        total: rows.length,
        updated: 0, 
        errors: [],
        failedRows: [],
        skippedRows: [],
        bulkOperationId: null
    };

    let allColumns = [];
    if (headersFromFrontend && headersFromFrontend.length > 0) {
        allColumns = headersFromFrontend;
    } else {
        const allColumnsSet = new Set();
        rows.forEach(row => {
            Object.keys(row).forEach(key => {
                if (!allColumnsSet.has(key)) {
                    allColumnsSet.add(key);
                    allColumns.push(key);
                }
            });
        });
    }

    const normalizeRow = (row, additionalFields = {}) => {
        const normalized = {};
        allColumns.forEach(col => {
            normalized[col] = row[col] !== undefined ? row[col] : "";
        });
        Object.keys(additionalFields).forEach(key => {
            normalized[key] = additionalFields[key];
        });
        return normalized;
    };

    let skuMap = new Map();
    
    let hasNextPage = true;
    let endCursor = null;

    // Fetch subscription for limit check
    const billingCheck = await admin.graphql(
        `#graphql
          query {
            currentAppInstallation {
              activeSubscriptions {
                name
                createdAt
              }
            }
          }
        `
    );
    const billingJson = await billingCheck.json();
    const planName = billingJson.data?.currentAppInstallation?.activeSubscriptions?.[0]?.name || "Free";

    while (hasNextPage) {
        const query = `#graphql
        query getPriceData($after: String) {
            productVariants(first: 250, after: $after) {
                pageInfo { hasNextPage endCursor }
                edges {
                    node {
                        id
                        sku
                        price
                        compareAtPrice
                        product {
                            id
                        }
                    }
                }
            }
        }`;
        
        const res = await admin.graphql(query, { variables: { after: endCursor } });
        const data = await res.json();
        
        data.data?.productVariants?.edges.forEach(edge => {
            const node = edge.node;
            if (node.sku) {
                skuMap.set(node.sku.toLowerCase(), {
                    id: node.id,
                    productId: node.product.id,
                    price: parseFloat(node.price),
                    compareAtPrice: node.compareAtPrice ? parseFloat(node.compareAtPrice) : null
                });
            }
        });
        
        hasNextPage = data.data?.productVariants?.pageInfo?.hasNextPage;
        endCursor = data.data?.productVariants?.pageInfo?.endCursor;
    }


    const processedCombinations = new Set();
    const bulkUpdates = [];

    for (const row of rows) {
        try {
            if (!row["SKU"] || row["SKU"] === "SKU") continue;

            const sku = String(row["SKU"]).trim();
            const skuKey = sku.toLowerCase();
            
            const priceRaw = row["Price"];
            const compareAtPriceRaw = row["CompareAt Price"];

            let newPrice = null;
            if (priceRaw !== undefined && priceRaw !== null && String(priceRaw).trim() !== "") {
                const parsed = parseFloat(priceRaw);
                if (isNaN(parsed)) {
                    results.errors.push(`Skipped SKU ${sku}: Invalid Price value '${priceRaw}'`);
                    results.failedRows.push(normalizeRow(row, { "Error Reason": 'Invalid Price value' }));
                    continue;
                }
                newPrice = parsed;
            }

            let newCompareAtPrice = null;
            let shouldClearCompareAt = false;
            
            if (compareAtPriceRaw !== undefined && compareAtPriceRaw !== null) {
                const trimmed = String(compareAtPriceRaw).trim();
                
                if (trimmed.toLowerCase() === "null") {
                    shouldClearCompareAt = true;
                } else if (trimmed !== "") {
                    const parsed = parseFloat(trimmed);
                    if (isNaN(parsed)) {
                        results.errors.push(`Skipped SKU ${sku}: Invalid CompareAt Price value '${compareAtPriceRaw}'`);
                        results.failedRows.push(normalizeRow(row, { "Error Reason": 'Invalid CompareAt Price value' }));
                        continue;
                    }
                    newCompareAtPrice = parsed;
                }
            }


            if (processedCombinations.has(skuKey)) {
                results.errors.push(`Skipped SKU ${sku}: Duplicate SKU in file`);
                results.failedRows.push(normalizeRow(row, { "Error Reason": 'Duplicate SKU in file' }));
                continue;
            }
            processedCombinations.add(skuKey);

            // Lookup variant
            const variantData = skuMap.get(skuKey);
            
            if (!variantData) {
                results.errors.push(`Variant not found for SKU: ${sku}`);
                results.failedRows.push(normalizeRow(row, { "Error Reason": 'Variant not found' }));
                continue;
            }

            const variantInput = {
                id: variantData.id
            };

            let needsUpdate = false;

            if (newPrice !== null && variantData.price !== newPrice) {
                variantInput.price = String(newPrice);
                needsUpdate = true;
            }

            if (shouldClearCompareAt) {
                if (variantData.compareAtPrice !== null) {
                    variantInput.compareAtPrice = null;
                    needsUpdate = true;
                }
            } else if (newCompareAtPrice !== null && variantData.compareAtPrice !== newCompareAtPrice) {
                variantInput.compareAtPrice = String(newCompareAtPrice);
                needsUpdate = true;
            }

            if (!needsUpdate) {
                results.skippedRows.push(normalizeRow(row, { "Reason": 'Prices already match' }));
                continue;
            }

            bulkUpdates.push({
                productId: variantData.productId,
                variantInput: variantInput
            });

        } catch (error) {
            results.errors.push(`Error processing SKU ${row["SKU"]}: ${error.message}`);
            results.failedRows.push(normalizeRow(row, { "Error Reason": error.message }));
        }
    }

    // --- USAGE LIMIT CHECK ---
    let priceUpdatesCount = 0;
    let compareAtUpdatesCount = 0;

    bulkUpdates.forEach(update => {
        if (update.variantInput.price) priceUpdatesCount++;
        if (update.variantInput.compareAtPrice !== undefined) compareAtUpdatesCount++;
    });

    const usageCheck = await checkUsageLimit(shop, planName, priceUpdatesCount, compareAtUpdatesCount);

    if (!usageCheck.allowed) {
        return { 
            success: false, 
            usageExceeded: true, 
            error: `Limit exceeded. You are attempting ${usageCheck.type === 'price' ? priceUpdatesCount : compareAtUpdatesCount} updates, but only ${usageCheck.limit - usageCheck.current} are remaining in your current billing period.`,
            type: usageCheck.type,
            limit: usageCheck.limit,
            current: usageCheck.current,
            attempted: usageCheck.attempted
        };
    }



    if (bulkUpdates.length === 0) {
        return { success: true, results };
    }

    const productGroups = new Map();
    bulkUpdates.forEach(update => {
        if (!productGroups.has(update.productId)) {
            productGroups.set(update.productId, []);
        }
        productGroups.get(update.productId).push(update.variantInput);
    });

    const jsonlLines = [];
    for (const [productId, variants] of productGroups) {
        jsonlLines.push(JSON.stringify({
            productId: productId,
            variants: variants
        }));
    }

    const { stagedUploadsCreate, userErrors: stageErrors } = await (await admin.graphql(`#graphql
    mutation stagedUploadsCreate($input: [StagedUploadInput!]!) {
        stagedUploadsCreate(input: $input) {
            stagedTargets { url resourceUrl parameters { name value } }
            userErrors { field message }
        }
    }`, {
        variables: {
            input: [{
                filename: "price_updates.jsonl",
                mimeType: "text/jsonl",
                httpMethod: "POST",
                resource: "BULK_MUTATION_VARIABLES"
            }]
        }
    })).json().then(r => r.data || {});

    if (stageErrors?.length > 0 || stagedUploadsCreate?.userErrors?.length > 0) {
        const msg = stageErrors?.[0]?.message || stagedUploadsCreate?.userErrors?.[0]?.message;
        results.errors.push("Failed to create upload target: " + msg);
        return { success: true, results };
    }

    const target = stagedUploadsCreate?.stagedTargets?.[0];
    if (target) {
        const formData = new FormData();
        const keyParam = target.parameters.find(p => p.name === "key");
        const uploadPath = keyParam?.value;

        target.parameters.forEach(p => formData.append(p.name, p.value));
        formData.append("file", new Blob([jsonlLines.join("\n")], { type: "text/jsonl" }));

        const uploadRes = await fetch(target.url, { method: "POST", body: formData });
        if (!uploadRes.ok) {
             results.errors.push(`Upload failed: ${uploadRes.statusText}`);
             return { success: true, results };
        }

        const bulkRes = await admin.graphql(`#graphql
        mutation bulkOperationRunMutation($mutation: String!, $stagedUploadPath: String!) {
            bulkOperationRunMutation(mutation: $mutation, stagedUploadPath: $stagedUploadPath) {
                bulkOperation { id }
                userErrors { field message }
            }
        }`, {
            variables: {
                mutation: `mutation productVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
                    productVariantsBulkUpdate(productId: $productId, variants: $variants) {
                        productVariants { id }
                        userErrors { field message }
                    }
                }`,
                stagedUploadPath: uploadPath
            }
        });
        
        const bulkData = await bulkRes.json();
        if (bulkData.data?.bulkOperationRunMutation?.userErrors?.length > 0) {
             results.errors.push("Bulk Mutation Error: " + bulkData.data.bulkOperationRunMutation.userErrors[0].message);
        } else {
             const opId = bulkData.data?.bulkOperationRunMutation?.bulkOperation?.id;
             console.log("Bulk Op Started:", opId, "Upload Key:", uploadPath);
             
             if (opId) {
                 results.bulkOperationId = opId;
                 // Store how many variants we queued for update
                 results.expectedUpdateCount = bulkUpdates.length;

                 // Increment usage in DB
                 await incrementUsage(shop, priceUpdatesCount, compareAtUpdatesCount);
             } else {
                 results.errors.push("Failed to trigger backend bulk operation (No ID returned)");
             }
        }
    } else {
        results.errors.push("Failed to get upload target URL");
    }

    return { success: true, results };
};

export default function ImportProductPrices() {
    const shopify = useAppBridge();
    const { usageStats, planName } = useLoaderData();
    const fetcher = useFetcher();
    const pollFetcher = useFetcher(); 
    
    const [file, setFile] = useState(null);
    const [parsedData, setParsedData] = useState(null);
    const [progress, setProgress] = useState(0);
    const [isProgressVisible, setIsProgressVisible] = useState(false);
    const fileInputRef = useRef(null);

    const [validatedResults, setValidatedResults] = useState(null);
    const [finalResults, setFinalResults] = useState(null);

    const [failedPage, setFailedPage] = useState(1);
    const failedRowsPerPage = 10;
    const [skippedPage, setSkippedPage] = useState(1);
    const skippedRowsPerPage = 10;

    const isLoading = fetcher.state === "submitting" || fetcher.state === "loading";

    const handleFileChange = (e) => {
        const selectedFile = e.target.files[0];
        if (selectedFile) {
            setFile(selectedFile);
            setFailedPage(1);
            setSkippedPage(1);
            setValidatedResults(null); 
            setFinalResults(null);

            e.target.value = ""; 

            const reader = new FileReader();
            reader.onload = async (event) => {
                const buffer = event.target.result;
                const workbook = new ExcelJS.Workbook();
                await workbook.xlsx.load(buffer);
                const worksheet = workbook.worksheets[0];
                const jsonData = [];
                const headers = [];
                worksheet.getRow(1).eachCell((cell, colNumber) => {
                   headers[colNumber] = cell.value ? String(cell.value).trim() : "";
                });
                worksheet.eachRow((row, rowNumber) => {
                    if (rowNumber > 1) {
                        const rowData = {};
                        row.eachCell((cell, colNumber) => {
                            if (headers[colNumber]) rowData[headers[colNumber]] = cell.value;
                        });
                        if (rowData["SKU"] && String(rowData["SKU"]).trim() !== "") {
                            jsonData.push(rowData);
                        }
                    }
                });
                setParsedData(jsonData);
                shopify.toast.show(`File loaded: ${jsonData.length} rows. Starting import...`, { duration: 5000 });
                setIsProgressVisible(true);
                setProgress(10);
                // Send headers to preserve column order
                const headersInOrder = headers.filter(h => h); // Remove empty entries
                fetcher.submit({ 
                    data: JSON.stringify(jsonData),
                    headers: JSON.stringify(headersInOrder)
                }, { method: "POST" });
            };
            reader.readAsArrayBuffer(selectedFile);
        }
    };

    const handleButtonClick = () => {
        if (fileInputRef.current) fileInputRef.current.click();
    };

    // --- HANDLE ACTION RESPONSE ---
    useEffect(() => {
        if (fetcher.data?.success && fetcher.state === "idle") {
            const res = fetcher.data.results;
            setValidatedResults(res);

            if (res.bulkOperationId) {
                pollFetcher.load(`/app/import-product-prices?checkStatus=true&operationId=${res.bulkOperationId}`);
            } else {
                setFinalResults(res); 
                setProgress(100);
                setTimeout(() => setIsProgressVisible(false), 2000);
                shopify.toast.show(`Import complete.`, { duration: 5000 });
            }
        }
    }, [fetcher.data, fetcher.state]);

    // --- POLLING ---
    useEffect(() => {
        if (validatedResults?.bulkOperationId) {
             const opId = validatedResults.bulkOperationId;
             if (pollFetcher.data && pollFetcher.data.operationId) {
                  if (pollFetcher.data.operationId !== opId) return;

                  if (pollFetcher.data.status === "RUNNING" || pollFetcher.data.status === "CREATED") {
                       const timer = setTimeout(() => {
                           pollFetcher.load(`/app/import-product-prices?checkStatus=true&operationId=${opId}`);
                       }, 2000);
                       return () => clearTimeout(timer);
                  } else if (pollFetcher.data.status === "COMPLETED") {
                       const bulkRes = pollFetcher.data.bulkResults || { errors: [] };
                       
                       const merged = {
                           ...validatedResults,
                           // Use the expected count we stored during validation
                           updated: validatedResults.expectedUpdateCount || 0,
                           errors: [...validatedResults.errors, ...bulkRes.errors]
                       };
                       setFinalResults(merged);
                       setProgress(100);
                       shopify.toast.show(`Import complete. ${merged.updated} products updated.`, { duration: 5000 });
                       setTimeout(() => setIsProgressVisible(false), 2000);
                  } else if (pollFetcher.data.status === "FAILED") {
                       shopify.toast.show("Background update failed.", { duration: 5000 });
                       setIsProgressVisible(false);
                  }
             }
        }
    }, [pollFetcher.data, validatedResults]);

    // --- PROGRESS UI ---
    useEffect(() => {
        if (isLoading) {
             const interval = setInterval(() => {
                setProgress((prev) => {
                    if (prev < 30) return prev + 2;
                    if (prev < 60) return prev + 0.5;
                    if (prev < 90) return prev + 0.05;
                    return prev;
                });
            }, 100);
            return () => clearInterval(interval);
        } else if (validatedResults?.bulkOperationId && !finalResults) {
             const interval = setInterval(() => {
                setProgress((prev) => {
                     if (prev < 80) return prev + 1;
                     if (prev < 95) return prev + 0.1; 
                     return prev;
                });
            }, 500);
            return () => clearInterval(interval);
        }
    }, [isLoading, validatedResults, finalResults]);

    const displayResults = finalResults || validatedResults;

    const renderUsageInfo = () => {
        if (!usageStats) return null;

        const { priceUpdates, compareAtUpdates, limits, priceRemaining, compareAtRemaining } = usageStats;
        
        return (
            <s-box paddingBlockStart="large">
                <Card>
                    <BlockStack gap="300">
                        <InlineStack align="space-between">
                            <Text variant="headingMd" as="h2">Plan Usage: <Badge tone="info">{planName}</Badge></Text>
                            <Text variant="bodySm" tone="subdued">Limits Reset On: {new Date(usageStats.nextResetDate).toLocaleDateString()}</Text>
                        </InlineStack>
                        
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px' }}>
                            <BlockStack gap="100">
                                <Text variant="bodyMd" fontWeight="bold">Price Updates</Text>
                                <Text variant="bodySm">
                                    {priceUpdates} / {limits.price === null ? 'Unlimited' : limits.price} used
                                </Text>
                                <Text variant="bodySm" tone={priceRemaining > 0 || limits.price === null ? 'success' : 'critical'}>
                                    {limits.price === null ? 'Unlimited remaining' : `${priceRemaining} left`}
                                </Text>
                            </BlockStack>

                            <BlockStack gap="100">
                                <Text variant="bodyMd" fontWeight="bold">Compare-At Price Updates</Text>
                                <Text variant="bodySm">
                                    {compareAtUpdates} / {limits.compareAt === null ? 'Unlimited' : limits.compareAt} used
                                </Text>
                                <Text variant="bodySm" tone={compareAtRemaining > 0 || limits.compareAt === null ? 'success' : 'critical'}>
                                    {limits.compareAt === null ? 'Unlimited remaining' : `${compareAtRemaining} left`}
                                </Text>
                            </BlockStack>
                        </div>
                    </BlockStack>
                </Card>
            </s-box>
        );
    };

    return (
        <s-page heading="Import Product Prices">
            {renderUsageInfo()}

            {fetcher.data?.usageExceeded && (
                <s-box paddingBlockStart="large">
                    <Banner tone="critical" title="Usage Limit Exceeded">
                        <p>{fetcher.data.error}</p>
                        <p>Please upgrade your plan to increase your limits.</p>
                        <s-button url="/app/subscription" variant="primary">Upgrade Plan</s-button>
                    </Banner>
                </s-box>
            )}

            <s-box paddingBlockStart="large">
                <s-section heading="Upload an Excel file with SKU, Price, and CompareAt Price columns.">
                    <input
                        ref={fileInputRef}
                        type="file"
                        accept=".xlsx,.xls"
                        onChange={handleFileChange}
                        style={{ display: 'none' }}
                    />

                    <s-button
                        variant="primary"
                        onClick={handleButtonClick}
                        loading={(isLoading || (validatedResults?.bulkOperationId && !finalResults)) ? "true" : undefined}
                        paddingBlock="large"
                    >
                        Import Product Prices
                    </s-button>
                </s-section>
            </s-box>

            {isProgressVisible && (
                <div className="progress-container">
                    <ProgressBar progress={progress} size="small" />
                    <s-text variant="bodyLg">
                         {validatedResults?.bulkOperationId && !finalResults ? "Processing price updates..." : "Importing product prices..."}
                    </s-text>
                </div>
            )}

            {displayResults && !isProgressVisible && (
                <>
                    <s-box paddingBlockStart="large">
                        <s-section heading="Import Results">
                            <s-stack gap="200" direction="block">
                                <s-text as="p">Total rows: {displayResults.total}</s-text>
                                <s-text as="p">Successfully updated: {displayResults.updated}</s-text>
                                <s-text as="p">Skipped: {displayResults.skippedRows?.length || 0}</s-text>
                                <s-text as="p">Errors: {displayResults.errors.length}</s-text>
                            </s-stack>
                        </s-section>
                    </s-box>

                    {displayResults.failedRows?.length > 0 && (
                        <s-box paddingBlockStart="large">
                            <s-section heading={`❌ Failed Rows (${displayResults.failedRows.length})`}>
                                <s-table>
                                    <s-table-header-row>
                                        {Object.keys(displayResults.failedRows[0] || {}).map((key) => (
                                            <s-table-header key={key}>{key}</s-table-header>
                                        ))}
                                    </s-table-header-row>
                                    <s-table-body>
                                        {displayResults.failedRows
                                            .slice((failedPage - 1) * failedRowsPerPage, failedPage * failedRowsPerPage)
                                            .map((row, index) => (
                                                <s-table-row key={index}>
                                                    {Object.keys(displayResults.failedRows[0] || {}).map((key, cellIndex) => (
                                                        <s-table-cell key={cellIndex}>
                                                            {row[key]?.toString() || '-'}
                                                        </s-table-cell>
                                                    ))}
                                                </s-table-row>
                                            ))}
                                    </s-table-body>
                                </s-table>
                                {displayResults.failedRows.length > failedRowsPerPage && (
                                    <Pagination
                                        hasPrevious={failedPage > 1}
                                        onPrevious={() => setFailedPage(failedPage - 1)}
                                        hasNext={failedPage < Math.ceil(displayResults.failedRows.length / failedRowsPerPage)}
                                        onNext={() => setFailedPage(failedPage + 1)}
                                        type="table"
                                        label={`${((failedPage - 1) * failedRowsPerPage) + 1}-${Math.min(failedPage * failedRowsPerPage, displayResults.failedRows.length)} of ${displayResults.failedRows.length}`}
                                    />
                                )}
                            </s-section>
                        </s-box>
                    )}

                    {displayResults.skippedRows?.length > 0 && (
                        <s-box paddingBlockStart="large" paddingBlockEnd="large">
                            <s-section heading={`⏭️ Skipped Rows (${displayResults.skippedRows.length}) - Prices Already Match`}>
                                <s-table>
                                    <s-table-header-row>
                                        {Object.keys(displayResults.skippedRows[0] || {}).map((key) => (
                                            <s-table-header key={key}>{key}</s-table-header>
                                        ))}
                                    </s-table-header-row>
                                    <s-table-body>
                                        {displayResults.skippedRows
                                            .slice((skippedPage - 1) * skippedRowsPerPage, skippedPage * skippedRowsPerPage)
                                            .map((row, index) => (
                                                <s-table-row key={index}>
                                                    {Object.keys(displayResults.skippedRows[0] || {}).map((key, cellIndex) => (
                                                        <s-table-cell key={cellIndex}>
                                                            {row[key]?.toString() || '-'}
                                                        </s-table-cell>
                                                    ))}
                                                </s-table-row>
                                            ))}
                                    </s-table-body>
                                </s-table>
                                {displayResults.skippedRows.length > skippedRowsPerPage && (
                                    <Pagination
                                        hasPrevious={skippedPage > 1}
                                        onPrevious={() => setSkippedPage(skippedPage - 1)}
                                        hasNext={skippedPage < Math.ceil(displayResults.skippedRows.length / skippedRowsPerPage)}
                                        onNext={() => setSkippedPage(skippedPage + 1)}
                                        type="table"
                                        label={`${((skippedPage - 1) * skippedRowsPerPage) + 1}-${Math.min(skippedPage * skippedRowsPerPage, displayResults.skippedRows.length)} of ${displayResults.skippedRows.length}`}
                                    />
                                )}
                            </s-section>
                        </s-box>
                    )}
                </>
            )}
        </s-page>
    );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
