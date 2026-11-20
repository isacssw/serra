// Worker (APP-14): the T3 provider and model that run jobs, how task branches are named, and the t3 command, and
// where Updates gets new code.
import { branchPatternForm, t3BinForm, updatesForm, workerForm } from './settings.logic.ts';
import { FieldsCard, SettingsPage, useSettings } from './SettingsKit.tsx';

const forms = [workerForm, branchPatternForm, t3BinForm, updatesForm];

export const Worker = () => {
  const state = useSettings();
  return (
    <SettingsPage title="Worker" sections={forms.map((form) => form.section)} state={state}>
      {(profile, settings) => forms.map((form) => <FieldsCard key={form.section} form={form} profile={profile} settings={settings} state={state} />)}
    </SettingsPage>
  );
};
