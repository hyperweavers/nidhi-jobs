# How to get Telegram Chat ID?

You can find a Telegram channel chat ID by using the Bot API getUpdates method.

## Steps

1. Add your bot to the target channel as an administrator.
2. Send a new message or post inside the channel or change bot's channel permissions.
3. Open your browser and go to `https://api.telegram.org/bot<BOT_TOKEN>/getUpdates` (replace `<BOT_TOKEN>` with your actual token from @BotFather).
4. Look at the JSON response for the `"chat"` or `"channel_post"` object; the `"id"` field will show your negative channel ID (e.g., `-100xxxxxxxxxx`).
