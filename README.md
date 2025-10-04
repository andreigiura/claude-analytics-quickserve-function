# Claude API Proxy Function

Secure serverless function to proxy Claude API requests and avoid CORS issues.

## Security Architecture

### How API Key is Stored & Used

```
┌─────────────────────────────────────────────────────────────┐
│ 1. Restaurant Owner enters API key in Settings              │
│    Frontend: Settings → Analytics AI → Enter API Key        │
└──────────────────────┬──────────────────────────────────────┘
                       ↓
┌─────────────────────────────────────────────────────────────┐
│ 2. API Key Stored in Appwrite Database (Encrypted)          │
│    Collection: restaurants                                   │
│    Document: {restaurantId}                                  │
│    Field: settings (JSON string)                             │
│    Value: { "claudeApiKey": "sk-ant-..." }                   │
└──────────────────────┬──────────────────────────────────────┘
                       ↓
┌─────────────────────────────────────────────────────────────┐
│ 3. Frontend Calls Analytics (NO API KEY SENT)               │
│    POST /functions/claude-proxy/executions                   │
│    Body: { "restaurantId": "abc123", "messages": [...] }    │
│    ❌ API key NEVER leaves the database                      │
└──────────────────────┬──────────────────────────────────────┘
                       ↓
┌─────────────────────────────────────────────────────────────┐
│ 4. Function Fetches Restaurant from Database                │
│    Uses Appwrite API Key (server-side only)                 │
│    Reads: restaurant.settings.claudeApiKey                   │
└──────────────────────┬──────────────────────────────────────┘
                       ↓
┌─────────────────────────────────────────────────────────────┐
│ 5. Function Calls Claude API (Server-Side)                  │
│    POST https://api.anthropic.com/v1/messages                │
│    Header: x-api-key: {claudeApiKey}                         │
│    ✅ No CORS issues (server-to-server)                      │
└──────────────────────┬──────────────────────────────────────┘
                       ↓
┌─────────────────────────────────────────────────────────────┐
│ 6. Returns AI Response to Frontend                          │
│    Response: { "content": [...] }                            │
└─────────────────────────────────────────────────────────────┘
```

### Security Benefits

1. **API Key Never in Browser**: The Claude API key is NEVER sent from the frontend
2. **Encrypted Storage**: API key stored in Appwrite database (encrypted at rest)
3. **No Exposure**: Even if someone inspects network traffic, they can't see the API key
4. **CORS Restricted**: Only `https://quickserve.io` can call this function
5. **Server-Side Only**: API key is only used server-side in the function

## CORS Configuration

**Allowed Origins:**
- `https://quickserve.io` (production)
- `http://localhost:5173` (development - Vite)
- `http://localhost:3000` (development - alternative)

**Requests from other origins will be rejected.**

## Environment Variables

The function automatically receives these from Appwrite:

- `APPWRITE_FUNCTION_API_ENDPOINT` - Appwrite endpoint URL
- `APPWRITE_FUNCTION_PROJECT_ID` - Your project ID
- `APPWRITE_API_KEY` - Server API key (auto-injected by Appwrite)

**No manual configuration needed!**

## Deployment

### 1. Deploy via Appwrite Console (Recommended)

1. Go to **Appwrite Console** → **Functions**
2. Click **"Create Function"**
3. Configure:
   - **Function ID**: `claude-proxy`
   - **Name**: `Claude API Proxy`
   - **Runtime**: `Node (18.0)`
   - **Execute Access**: `Any` (function validates internally)
   - **Timeout**: `30` seconds
4. **Deploy**:
   - Go to "Deployments" tab
   - Click "Create deployment"
   - Upload folder: `/claude-proxy/src/`
   - **Entrypoint**: `main.js`
   - Click "Deploy"
5. Wait for build to complete (~1-2 minutes)

### 2. Test the Function

```bash
curl -X POST \
  https://cloud.appwrite.io/v1/functions/claude-proxy/executions \
  -H "Content-Type: application/json" \
  -H "X-Appwrite-Project: YOUR_PROJECT_ID" \
  -d '{
    "restaurantId": "YOUR_RESTAURANT_ID",
    "messages": [{"role": "user", "content": "Hello"}],
    "model": "claude-3-5-sonnet-20241022",
    "max_tokens": 50
  }'
```

## Request Format

```json
{
  "restaurantId": "abc123",
  "messages": [
    {
      "role": "user",
      "content": "Analyze this data..."
    }
  ],
  "model": "claude-3-5-sonnet-20241022",
  "max_tokens": 2000
}
```

## Response Format

**Success (200):**
```json
{
  "id": "msg_...",
  "type": "message",
  "role": "assistant",
  "content": [
    {
      "type": "text",
      "text": "AI response here..."
    }
  ],
  "model": "claude-3-5-sonnet-20241022",
  "usage": {
    "input_tokens": 150,
    "output_tokens": 250
  }
}
```

**Error (400/404/500):**
```json
{
  "error": "No Claude API key configured. Please add one in Settings → Analytics AI"
}
```

## Error Handling

| Error | Status | Cause |
|-------|--------|-------|
| `restaurantId is required` | 400 | Missing restaurantId in request |
| `messages array is required` | 400 | Missing or invalid messages |
| `Restaurant not found` | 404 | Invalid restaurant ID |
| `No Claude API key configured` | 400 | Restaurant has no API key in settings |
| `Claude API request failed` | 4xx/5xx | Claude API error (invalid key, quota, etc.) |
| `Internal server error` | 500 | Function error |

## Logs

View function logs in Appwrite Console → Functions → claude-proxy → Logs

**Example log output:**
```
[INFO] Fetching restaurant abc123 to get API key...
[INFO] Calling Claude API...
[INFO] Claude API call successful
```

## Cost

**Appwrite Function Costs:**
- Free tier: 750,000 executions/month
- Each analytics page load = 1 execution
- Typical usage: 10-50 executions/day per restaurant

**Claude API Costs:**
- Billed by Anthropic based on tokens
- ~$0.01-0.05 per analytics page view
- Depends on data volume

## Troubleshooting

### "Function not found"
- Verify function ID is `claude-proxy` in Appwrite Console
- Check `.env` has correct `VITE_CLAUDE_PROXY_FUNCTION_ID`

### "No Claude API key configured"
- Go to Settings → Analytics AI
- Enter and save a valid Claude API key
- Test the key using "Test" button

### "CORS error"
- Verify your domain is in `allowedOrigins` array in `main.js`
- Redeploy function after changing origins

### "Function timeout"
- Claude API is slow - increase timeout to 60s in function settings
- Or reduce `max_tokens` in request

## Development

```bash
# Install dependencies
npm install

# Format code
npm run format
```

## Dependencies

- `node-appwrite` (v13.0.0) - Appwrite SDK for fetching restaurant data
