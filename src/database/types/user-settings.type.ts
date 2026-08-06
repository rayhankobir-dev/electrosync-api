export interface UserSettings {
  pushEnabled?: boolean;
  lowBalanceAlerts?: boolean;
  lowBalanceThreshold?: number;
  rechargeAlerts?: boolean;
  language?: 'en' | 'bn';
  theme?: 'light' | 'dark' | 'system';
}

export const DEFAULT_USER_SETTINGS: Required<UserSettings> = {
  pushEnabled: true,
  lowBalanceAlerts: true,
  lowBalanceThreshold: 100,
  rechargeAlerts: true,
  language: 'en',
  theme: 'system',
};
