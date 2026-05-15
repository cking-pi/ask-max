# Ask Max Netlify Test App

This zip intentionally does not include API keys or secrets. Add them in Netlify Environment Variables.

Required variables:

OPENAI_ASSISTANT_ID=your_openai_assistant_id
GOOGLE_SCRIPT_WEB_APP_URL=your_google_script_web_app_url
GOOGLE_SCRIPT_SECRET=your_google_script_secret
ALLOWED_ORIGIN=*

For launch, change ALLOWED_ORIGIN to:
https://www.parkindustries.com

Test page:
Open the Netlify site URL after deploy and submit the form on index.html.

Important:
Do not put API keys directly into this zip or any public file.
