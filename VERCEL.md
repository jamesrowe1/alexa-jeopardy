# Deploy Alexa Jeopardy to Vercel

This version exposes the Alexa skill as an HTTPS endpoint at `/alexa`.

## Environment variables

Set these in Vercel Project Settings > Environment Variables:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `ALEXA_SKILL_ID`

Never commit your real secret key.

## Deploy

From the project root:

```bash
npm install
npm install -g vercel
vercel
vercel --prod
```

Your Alexa endpoint will be:

```text
https://YOUR-VERCEL-DOMAIN.vercel.app/alexa
```

The root URL (`/`) is only a health check.

## Alexa Developer Console

Under Build > Custom > Endpoint:

1. Select **HTTPS**.
2. Set Default Region to your Vercel `/alexa` URL.
3. Choose the option indicating that the development endpoint has a certificate from a trusted certificate authority.
4. Save endpoints.

Then build the interaction model and enable testing under the Test tab.
