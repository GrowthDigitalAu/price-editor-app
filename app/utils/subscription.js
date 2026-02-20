export function getVariantLimitForPlan(planName) {
    if (!planName) return { price: 30, compareAt: 30 };
    
    const lowerPlan = planName.toLowerCase();
    
    if (lowerPlan.includes('starter')) return { price: 300, compareAt: 300 };
    if (lowerPlan.includes('growth')) return { price: null, compareAt: null }; // unlimited
    
    return { price: 30, compareAt: 30 }; // free tier
}

export const SUBSCRIPTION_TIERS = {
    FREE: { 
        name: 'Free', 
        priceLimit: 3000, 
        compareAtLimit: 3000,
        description: '30 variant price updates & 30 compare-at price updates'
    },
    STARTER: { 
        name: 'Starter', 
        priceLimit: 5000, 
        compareAtLimit: 5000,
        description: '5000 variant price updates & 5000 compare-at price updates'
    },
    GROWTH: { 
        name: 'Growth', 
        priceLimit: null, 
        compareAtLimit: null,
        description: 'Unlimited price updates'
    }
};

