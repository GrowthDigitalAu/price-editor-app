import prisma from "../db.server";
import { getVariantLimitForPlan } from "./subscription";

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Get current billing period start date based on 30-day intervals
 * Starting from the startedAt date
 */
function getCurrentBillingPeriod(startedAt) {
  const start = new Date(startedAt).getTime();
  const now = new Date().getTime();
  
  if (now < start) return new Date(start).toISOString().split('T')[0];
  
  const diff = now - start;
  const cycleCount = Math.floor(diff / THIRTY_DAYS_MS);
  const periodStart = new Date(start + (cycleCount * THIRTY_DAYS_MS));
  
  return periodStart.toISOString().split('T')[0];
}

/**
 * Get next reset date for 30-day billing cycle
 */
function getNextResetDate(startedAt) {
  const start = new Date(startedAt).getTime();
  const now = new Date().getTime();
  
  if (now < start) return new Date(start + THIRTY_DAYS_MS);
  
  const diff = now - start;
  const nextCycleCount = Math.floor(diff / THIRTY_DAYS_MS) + 1;
  return new Date(start + (nextCycleCount * THIRTY_DAYS_MS));
}

/**
 * Get or create subscription info for a shop
 */
export async function getOrCreateSubscriptionInfo(shop, subscription) {
  let subInfo = await prisma.subscriptionInfo.findUnique({
    where: { shop }
  });
  
  if (!subInfo) {
    // Create new subscription info
    // Use subscription createdAt or current date
    const startDate = subscription?.createdAt 
      ? new Date(subscription.createdAt) 
      : new Date();
    
    subInfo = await prisma.subscriptionInfo.create({
      data: {
        shop,
        subscriptionId: subscription?.id,
        planName: subscription?.name || "Free",
        startedAt: startDate
      }
    });
  } else if ((subscription && subInfo.subscriptionId !== subscription.id) || (!subscription && subInfo.subscriptionId)) {
    // Update if subscription changed OR if they no longer have an active subscription
    
    // Every time a subscription is created or updated, we reset the startedAt to now (or the subscription's start date)
    // This ensures the usage count resets to 0 and a new 30-day window begins.
    const newStartDate = subscription?.createdAt ? new Date(subscription.createdAt) : new Date();

    subInfo = await prisma.subscriptionInfo.update({
      where: { shop },
      data: {
        subscriptionId: subscription?.id || null,
        planName: subscription?.name || "Free",
        startedAt: newStartDate
      }
    });
  }
  
  return subInfo;
}

/**
 * Get current billing period usage for a shop
 */
export async function getCurrentBillingUsage(shop) {
  const subInfo = await prisma.subscriptionInfo.findUnique({
    where: { shop }
  });
  
  if (!subInfo) {
    throw new Error("Subscription info not found for shop");
  }
  
  const billingPeriod = getCurrentBillingPeriod(subInfo.startedAt);
  
  let usage = await prisma.usageTracking.findUnique({
    where: { 
      shop_billingPeriod: { 
        shop, 
        billingPeriod 
      } 
    }
  });
  
  if (!usage) {
    usage = await prisma.usageTracking.create({
      data: {
        shop,
        billingPeriod,
        priceUpdates: 0,
        compareAtUpdates: 0
      }
    });
  }
  
  return { 
    usage, 
    billingPeriod, 
    nextResetDate: getNextResetDate(subInfo.startedAt) 
  };
}

/**
 * Increment usage counters for current billing period
 */
export async function incrementUsage(shop, priceCount, compareAtCount) {
  const subInfo = await prisma.subscriptionInfo.findUnique({
    where: { shop }
  });
  
  if (!subInfo) {
    throw new Error("Subscription info not found");
  }
  
  const billingPeriod = getCurrentBillingPeriod(subInfo.startedAt);
  
  return await prisma.usageTracking.upsert({
    where: { 
      shop_billingPeriod: { 
        shop, 
        billingPeriod 
      } 
    },
    update: {
      priceUpdates: { increment: priceCount },
      compareAtUpdates: { increment: compareAtCount }
    },
    create: {
      shop,
      billingPeriod,
      priceUpdates: priceCount,
      compareAtUpdates: compareAtCount
    }
  });
}

/**
 * Check if import is within usage limits
 */
export async function checkUsageLimit(shop, subscriptionName, newPriceCount, newCompareAtCount) {
  const limits = getVariantLimitForPlan(subscriptionName);
  const { usage } = await getCurrentBillingUsage(shop);
  
  // Unlimited tier
  if (limits.price === null) {
    return { allowed: true };
  }
  
  // Check price limit
  if (usage.priceUpdates + newPriceCount > limits.price) {
    return { 
      allowed: false, 
      type: 'price',
      limit: limits.price,
      current: usage.priceUpdates,
      attempted: newPriceCount
    };
  }
  
  // Check compare-at limit
  if (usage.compareAtUpdates + newCompareAtCount > limits.compareAt) {
    return { 
      allowed: false, 
      type: 'compareAt',
      limit: limits.compareAt,
      current: usage.compareAtUpdates,
      attempted: newCompareAtCount
    };
  }
  
  return { allowed: true };
}

/**
 * Get formatted usage statistics for display
 */
export async function getUsageStats(shop, subscriptionName) {
  const limits = getVariantLimitForPlan(subscriptionName);
  const { usage, nextResetDate } = await getCurrentBillingUsage(shop);
  
  return {
    priceUpdates: usage.priceUpdates,
    compareAtUpdates: usage.compareAtUpdates,
    limits,
    nextResetDate,
    priceRemaining: limits.price ? limits.price - usage.priceUpdates : null,
    compareAtRemaining: limits.compareAt ? limits.compareAt - usage.compareAtUpdates : null
  };
}
