import { bootstrapApplication } from '@angular/platform-browser';
import { AppComponent } from './app.component';

bootstrapApplication(AppComponent).catch(error => {
  console.error('Falha ao iniciar o frontend Angular do Painel:', error);
});
