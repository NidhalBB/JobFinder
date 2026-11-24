export function discoveryLinks(country = 'Tunisia', role = '') {
  role = String(role).slice(0, 120);
  const region = country === 'All countries' ? '' : country;
  const query = `${String(role).slice(0, 120)} jobs ${region}`.trim();
  const google = q => `https://www.google.com/search?${new URLSearchParams({ q })}`;
  const links = [
    { name: 'Google job search', url: google(query), coverage: region || 'Worldwide' },
    { name: 'LinkedIn Jobs', url: `https://www.linkedin.com/jobs/search/?${new URLSearchParams({ keywords: role, location: region })}`, coverage: region || 'Worldwide' },
    { name: 'Indeed via Google', url: google(`site:indeed.com ${query}`), coverage: region || 'Worldwide' },
    { name: 'Himalayas country search', url: `https://himalayas.app/jobs?${new URLSearchParams({ country: region, query: role })}`, coverage: region || 'Worldwide' },
  ];
  if (country === 'Tunisia' || country === 'All countries') links.unshift(
    { name: 'Tanitjobs', url: google(`site:tanitjobs.com/job/ ${role} Tunisie`), coverage: 'Tunisia', home: 'https://www.tanitjobs.com/' },
    { name: 'Keejob', url: google(`site:keejob.com/offres-emploi/ ${role} Tunisie`), coverage: 'Tunisia', home: 'https://www.keejob.com/' },
    { name: 'ANETI', url: 'https://www.emploi.nat.tn/', coverage: 'Tunisia' },
  );
  return links;
}
