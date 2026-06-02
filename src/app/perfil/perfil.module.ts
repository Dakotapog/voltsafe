import { IonicModule } from '@ionic/angular';
import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { PerfilPage } from './perfil.page';
import { EnmeComponent } from './enme.component';
import { PerfilPageRoutingModule } from './perfil-routing.module';

@NgModule({
  imports: [IonicModule, CommonModule, FormsModule, PerfilPageRoutingModule, EnmeComponent],
  declarations: [PerfilPage],
})
export class PerfilPageModule {}
