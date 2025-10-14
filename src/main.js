import { Client, Databases } from 'node-appwrite';

/**
 * Appwrite Function: Claude API Proxy
 *
 * This function proxies requests to the Claude API to avoid CORS issues.
 *
 * SECURITY FLOW:
 * 1. Frontend sends: { restaurantId, messages }
 * 2. Function fetches restaurant from database
 * 3. Function extracts API key from restaurant.settings
 * 4. Function calls Claude API with the key
 * 5. Returns AI response to frontend
 *
 * This way:
 * - API key is NEVER sent from browser
 * - API key is stored only in Appwrite database
 * - Frontend only needs to send restaurant ID
 */

export default async ({ req, res, log, error }) => {
  // Only allow requests from quickserve.io and localhost (for development)
  const allowedOrigins = [
    'https://quickserve.io',
    'http://localhost:5173',
    'http://localhost:3000'
  ];

  const origin = req.headers['origin'] || req.headers['referer'];
  const isAllowed = allowedOrigins.some(allowed => origin?.startsWith(allowed));

  const corsHeaders = {
    'Access-Control-Allow-Origin': isAllowed ? origin : 'https://quickserve.io',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Appwrite-Project, X-Appwrite-JWT',
  };

  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return res.send('', 200, corsHeaders);
  }

  // Only allow POST
  if (req.method !== 'POST') {
    return res.json({ error: 'Method not allowed' }, 405, corsHeaders);
  }

  try {
    // Check authentication
    const userId = req.headers['x-appwrite-user-id'];
    if (!userId) {
      error('No authenticated user');
      return res.json({ error: 'Authentication required' }, 401, corsHeaders);
    }

    log(`Authenticated user: ${userId}`);

    // Parse request body
    log(`Request body type: ${typeof req.body}`);
    log(`Request body: ${JSON.stringify(req.body)}`);

    let body;
    try {
      body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    } catch (parseErr) {
      error(`Failed to parse request body: ${parseErr.message}`);
      return res.json({ error: 'Invalid JSON in request body' }, 400, corsHeaders);
    }

    const { restaurantId, messages, model = 'claude-3-5-sonnet-20241022', max_tokens = 2000 } = body || {};

    // Validate input
    if (!restaurantId) {
      error('Missing restaurantId');
      return res.json({ error: 'restaurantId is required' }, 400, corsHeaders);
    }

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      error('Invalid or missing messages');
      return res.json({ error: 'messages array is required' }, 400, corsHeaders);
    }

    // Initialize Appwrite client
    const client = new Client()
      .setEndpoint(process.env.APPWRITE_FUNCTION_API_ENDPOINT)
      .setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID)
      .setKey(process.env.APPWRITE_API_KEY);

    const databases = new Databases(client);

    log(`Fetching user ${userId} to validate subscription...`);

    // Fetch user document to check subscription
    let userDoc;
    try {
      userDoc = await databases.getDocument(
        'main_database',
        'users',
        userId
      );
    } catch (err) {
      error(`Failed to fetch user: ${err.message}`);
      return res.json({ error: 'User not found' }, 404, corsHeaders);
    }

    // Validate subscription
    const subscription = userDoc.subscription;
    const validSubscriptions = ['starter', 'growth', 'pro'];

    if (!subscription || !validSubscriptions.includes(subscription)) {
      error(`User does not have valid subscription: ${subscription}`);
      return res.json({
        error: 'AI Analytics requires an active subscription',
        message: 'Please subscribe to a plan (Starter, Growth, or Pro) to use AI-powered analytics'
      }, 403, corsHeaders);
    }

    log(`User has valid subscription: ${subscription}`);
    log(`Fetching restaurant ${restaurantId} to validate ownership and settings...`);

    // Fetch restaurant document
    let restaurant;
    try {
      restaurant = await databases.getDocument(
        'main_database',
        'restaurants',
        restaurantId
      );
    } catch (err) {
      error(`Failed to fetch restaurant: ${err.message}`);
      return res.json({ error: 'Restaurant not found' }, 404, corsHeaders);
    }

    // Validate ownership
    if (restaurant.ownerId !== userId) {
      error(`User ${userId} does not own restaurant ${restaurantId} (owner: ${restaurant.ownerId})`);
      return res.json({
        error: 'Access denied',
        message: 'You do not have permission to access this restaurant\'s AI analytics'
      }, 403, corsHeaders);
    }

    log(`Ownership validated. User owns restaurant.`);

    // Parse settings to check if AI analytics is enabled
    let aiAnalyticsEnabled = false;
    try {
      log(`Restaurant settings (raw): ${restaurant.settings}`);
      const settings = restaurant.settings ? JSON.parse(restaurant.settings) : {};
      log(`Parsed settings: ${JSON.stringify(settings)}`);
      aiAnalyticsEnabled = settings.aiAnalyticsEnabled === true;
      log(`AI Analytics enabled: ${aiAnalyticsEnabled}`);
    } catch (parseError) {
      error(`Failed to parse restaurant settings: ${parseError.message}`);
      return res.json({ error: 'Invalid restaurant settings format' }, 500, corsHeaders);
    }

    // Validate AI analytics is enabled
    if (!aiAnalyticsEnabled) {
      error(`AI analytics not enabled for restaurant ${restaurantId}`);
      return res.json({
        error: 'AI Analytics not enabled',
        message: 'Please enable AI Analytics in Settings → Analytics AI'
      }, 400, corsHeaders);
    }

    // Get global Claude API key from environment
    const apiKey = process.env.CLAUDE_API_KEY;
    if (!apiKey || !apiKey.startsWith('sk-ant-')) {
      error(`Global Claude API key not configured in function environment`);
      return res.json({
        error: 'Service configuration error',
        message: 'AI Analytics service is not properly configured. Please contact support.'
      }, 500, corsHeaders);
    }

    log('Calling Claude API...');

    // Call Claude API
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens,
        messages,
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      error(`Claude API error: ${JSON.stringify(data)}`);
      return res.json({
        error: data.error?.message || 'Claude API request failed',
        details: data
      }, response.status);
    }

    log('Claude API call successful');

    // Return Claude response
    return res.json(data, 200, corsHeaders);

  } catch (err) {
    error(`Function error: ${err.message}`);

    // Handle specific error types
    if (err.code === 404) {
      return res.json({
        error: 'Restaurant not found',
        message: 'Invalid restaurant ID'
      }, 404);
    }

    return res.json({
      error: 'Internal server error',
      message: err.message
    }, 500);
  }
};
