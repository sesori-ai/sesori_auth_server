export enum MongoDbDatabase {
  Auth = "oauth",
}

export enum AuthDbCollection {
  Users = "users",
  OAuthAccounts = "oauthAccounts",
  PasswordAccounts = "passwordAccounts",
  GlossaryEntries = "glossaryEntries",
  DailyUsage = "dailyUsage",
  DeviceTokens = "deviceTokens",
}
