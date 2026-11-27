// Bot & Slack (APP-14): the bot's name and id, the owner, the review channel and the service label.
import { botForm, ownerForm, reviewForm, serviceLabelForm } from './settings.logic.ts';
import { FieldsCard, SettingsPage, useSettings } from './SettingsKit.tsx';

const forms = [botForm, ownerForm, reviewForm, serviceLabelForm];

export const BotSlack = () => {
  const state = useSettings();
  return (
    <SettingsPage title="Bot & Slack" state={state}>
      {(profile, settings) => forms.map((form) => <FieldsCard key={form.section} form={form} profile={profile} settings={settings} state={state} />)}
    </SettingsPage>
  );
};
