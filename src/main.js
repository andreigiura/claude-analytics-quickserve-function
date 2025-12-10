import { Client, Databases, Users } from 'node-appwrite';

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

    const { restaurantId, analyticsData } = body || {};

    // Validate input
    if (!restaurantId) {
      error('Missing restaurantId');
      return res.json({ error: 'restaurantId is required' }, 400, corsHeaders);
    }

    if (!analyticsData) {
      error('Missing analyticsData');
      return res.json({ error: 'analyticsData is required' }, 400, corsHeaders);
    }

    // Initialize Appwrite client
    const client = new Client()
      .setEndpoint(process.env.APPWRITE_FUNCTION_API_ENDPOINT)
      .setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID)
      .setKey(process.env.APPWRITE_API_KEY);

    const databases = new Databases(client);
    const usersService = new Users(client);

    log(`Fetching user ${userId} to validate subscription...`);

    // Fetch user from Appwrite Auth to check labels
    let userDoc;
    try {
      log(`Attempting to fetch user with ID: ${userId}`);
      log(`Using endpoint: ${process.env.APPWRITE_FUNCTION_API_ENDPOINT}`);
      log(`Using project: ${process.env.APPWRITE_FUNCTION_PROJECT_ID}`);
      log(`API key present: ${!!process.env.APPWRITE_API_KEY}`);
      userDoc = await usersService.get(userId);
      log(`User fetched successfully: ${userDoc.$id}`);
    } catch (err) {
      error(`Failed to fetch user: ${err.message}`);
      error(`Error code: ${err.code}`);
      error(`Error type: ${err.type}`);
      return res.json({ error: 'User not found', details: err.message }, 404, corsHeaders);
    }

    // Validate subscription by checking user labels
    const labels = userDoc.labels || [];
    let subscription = null;
    if (labels.includes('planstarter')) subscription = 'starter';
    else if (labels.includes('plangrowth')) subscription = 'growth';
    else if (labels.includes('planpro')) subscription = 'pro';

    if (!subscription) {
      error(`User does not have valid subscription. Labels: ${labels.join(', ')}`);
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

    // Generate prompt server-side (never trust client input for prompts)
    const prompt = generateAnalyticsPrompt(analyticsData);

    // Call Claude API with server-controlled model and settings
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2000,
        messages: [{ role: 'user', content: prompt }],
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

/**
 * Generate analytics prompt server-side for security
 * Only accepts structured data, never raw prompt text from client
 */
function generateAnalyticsPrompt(data) {
  const { productSales = [], sessionMetrics = {}, feedbackSummary = {}, feedbackComments = [], topSellerIssues } = data;

  // Format product sales (limit to top 10)
  const productsText = productSales.slice(0, 10).map((p, i) => {
    const rating = p.averageRating ? `, ${p.averageRating.toFixed(1)}★ rating (${p.feedbackCount || 0} reviews)` : '';
    return `${i + 1}. ${p.productName}: ${p.timesOrdered} orders, $${(p.totalRevenue || 0).toFixed(2)} revenue${rating}`;
  }).join('\n');

  // Format feedback distribution
  const dist = feedbackSummary.ratingDistribution || {};
  const distText = `5★(${dist[5] || 0}) 4★(${dist[4] || 0}) 3★(${dist[3] || 0}) 2★(${dist[2] || 0}) 1★(${dist[1] || 0})`;

  // Format comments (limit to 20, sanitize)
  const commentsText = feedbackComments.length > 0
    ? `Recent Customer Comments (sample):\n${feedbackComments.slice(0, 20).map((c, i) => `${i + 1}. "${String(c).substring(0, 200)}"`).join('\n')}`
    : '';

  // Top seller issues note
  const issuesText = topSellerIssues
    ? `\nNOTE: "${topSellerIssues.productName}" is the top seller but has a low ${(topSellerIssues.rating || 0).toFixed(1)}★ rating. Analyze feedback comments for this item if mentioned.`
    : '';

  return `You are an expert restaurant analytics consultant. Analyze the following restaurant data from the LAST 30 DAYS and provide actionable insights. Focus on:

1. Customer satisfaction patterns from feedback comments
2. Menu item performance and quality issues
3. Operational efficiency opportunities
4. Revenue optimization suggestions

DATA (Last 30 Days):
Top Products:
${productsText || 'No product data available'}

Session Metrics:
- Total Sessions: ${sessionMetrics.total || 0}
- Avg Duration: ${(sessionMetrics.avgDuration || 0).toFixed(0)} minutes
- Avg Revenue per Session: $${(sessionMetrics.avgRevenue || 0).toFixed(2)}
- Avg Orders per Session: ${(sessionMetrics.avgOrdersPerSession || 0).toFixed(1)}

Customer Feedback:
- Total: ${feedbackSummary.totalFeedbacks || 0} (${feedbackSummary.hasComments || 0} with comments)
- Average Rating: ${(feedbackSummary.averageRating || 0).toFixed(2)}★
- Distribution: ${distText}

${commentsText}
${issuesText}

INSTRUCTIONS:
Provide 3-5 specific, actionable insights in the following JSON format:
[
  {
    "severity": "critical|warning|info",
    "category": "quality|revenue|operations|satisfaction",
    "message": "Concise insight message with specific data points and actionable recommendation",
    "impact": <number 1-10>,
    "confidence": <number 0-1>
  }
]

Focus on:
- Sentiment patterns in feedback comments (recurring themes, common complaints/praise)
- Non-obvious correlations or patterns in the data
- Specific product quality issues mentioned in feedback
- Revenue opportunities or operational inefficiencies
- Concrete next steps the restaurant can take

Return ONLY the JSON array, no other text.`;
}
